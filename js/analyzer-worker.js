/**
 * analyzer-worker.js — 分析层（Web Worker）
 * 职责：
 *  1. 聚合主线程批量上报的帧/longtask/measure/resource/memory/error 数据
 *  2. 掉帧判定：帧耗时 > 2×帧预算 视为掉帧
 *  3. 归因：把每个掉帧窗口与长任务、measure、资源加载、内存增长（GC 嫌疑）做时间重叠分析
 *  4. 建议：规则引擎，把归因结果映射为可操作的优化建议
 *  5. 报告：维护会话级统计，可随时导出
 */
'use strict';

var DROP_FACTOR = 2.0;        // 帧耗时超过 2 倍预算 = 掉帧
var GC_GROWTH_BYTES = 8 * 1024 * 1024; // 掉帧前内存上涨超 8MB 视为 GC 嫌疑
var MAX_EVENTS = 2000;        // 事件环形上限，控制内存

var state = {
  startedAt: Date.now(),
  refreshRate: 60,
  frameBudget: 16.7,
  totalFrames: 0,
  droppedFrames: 0,
  frameTimeSum: 0,
  worstFrame: 0,
  fpsSamples: [],
  drops: [],            // 掉帧事件（含归因）
  longTasks: [],
  errors: [],
  memory: [],
  causeCounts: {},      // 归因统计
  suggestions: []       // 当前生效建议
};

/* ---------------- 归因规则 ---------------- */

/**
 * 对一个掉帧窗口 [start, end] 做归因，返回 { cause, detail, confidence }
 * 优先级：长任务 > 业务打点(measure) > 资源加载 > GC 嫌疑 > 主线程外因素
 */
function attributeDrop(dropStart, dropEnd, ctx) {
  // 1. 长任务重叠
  var overlapping = ctx.longTasks.filter(function (lt) {
    return lt.start < dropEnd && (lt.start + lt.duration) > dropStart;
  });
  if (overlapping.length) {
    var lt = overlapping.sort(function (a, b) { return b.duration - a.duration; })[0];
    var src = '页面脚本';
    (lt.attribution || []).forEach(function (a) {
      if (a.containerSrc) src = a.containerSrc;
      else if (a.containerName) src = a.containerName;
      else if (a.containerType && a.containerType !== 'window') src = a.containerType;
    });
    return {
      cause: 'long-task',
      detail: '长任务 ' + Math.round(lt.duration) + 'ms（来源: ' + src + '）阻塞主线程',
      confidence: 0.95,
      ref: lt
    };
  }

  // 2. 业务 measure 重叠（布局/脚本打点）
  var measures = ctx.measures.filter(function (m) {
    return m.start < dropEnd && (m.start + m.duration) > dropStart;
  });
  if (measures.length) {
    var m = measures.sort(function (a, b) { return b.duration - a.duration; })[0];
    var cause = /layout|style|reflow/i.test(m.name) ? 'layout-thrash'
      : /first-input/.test(m.name) ? 'input-delay'
      : 'script-measure';
    return {
      cause: cause,
      detail: '打点 "' + m.name + '" 耗时 ' + Math.round(m.duration) + 'ms 与掉帧窗口重叠',
      confidence: 0.8,
      ref: m
    };
  }

  // 3. 慢资源加载重叠
  var resources = ctx.resources.filter(function (r) {
    return r.start < dropEnd && (r.start + r.duration) > dropStart;
  });
  if (resources.length) {
    var r = resources[0];
    return {
      cause: 'resource-loading',
      detail: '资源 ' + shorten(r.name) + '（' + r.type + ', ' + Math.round(r.duration) + 'ms）加载/解码占用主线程',
      confidence: 0.6,
      ref: r
    };
  }

  // 4. GC 嫌疑：掉帧前 2s 内堆内存快速上涨
  if (ctx.memory.length >= 2) {
    var before = ctx.memory.filter(function (s) {
      return s.t < dropStart && (dropStart - s.t) < 2000;
    }).slice(-3);
    if (before.length >= 2) {
      var growth = before[before.length - 1].used - before[0].used;
      if (growth > GC_GROWTH_BYTES) {
        return {
          cause: 'gc-pressure',
          detail: '掉帧前堆内存上涨 ' + (growth / 1048576).toFixed(1) + 'MB，疑似 GC 停顿',
          confidence: 0.5
        };
      }
    }
  }

  // 5. 无法归因
  return {
    cause: 'unknown',
    detail: '未捕获到重叠的长任务/打点/资源，可能为合成器负载、GPU 光栅化或系统级抢占',
    confidence: 0.2
  };
}

function shorten(url) {
  try {
    var u = url.split('/').pop();
    return u.length > 40 ? u.slice(0, 37) + '...' : u;
  } catch (e) { return url; }
}

/* ---------------- 建议规则引擎 ---------------- */

var RULES = [
  {
    when: function (s) { return (s.causeCounts['long-task'] || 0) > 0; },
    suggest: function (s) {
      return {
        id: 'split-long-task',
        priority: 'high',
        cause: 'long-task',
        title: '拆分长任务，让出主线程',
        action: '将 >50ms 的同步计算拆成小片：使用 scheduler.yield()/setTimeout(0) 分片，或移入 Web Worker；用 performance.measure 包裹可疑代码段定位热点。'
      };
    }
  },
  {
    when: function (s) { return (s.causeCounts['layout-thrash'] || 0) > 0; },
    suggest: function () {
      return {
        id: 'avoid-layout-thrash',
        priority: 'high',
        cause: 'layout-thrash',
        title: '消除布局抖动（Layout Thrashing）',
        action: '避免在循环中交替读写布局属性（如 offsetWidth 后立即改样式）；批量读→批量写；用 transform/opacity 替代触发回流的属性；考虑 content-visibility 与 contain。'
      };
    }
  },
  {
    when: function (s) { return (s.causeCounts['gc-pressure'] || 0) >= 2; },
    suggest: function () {
      return {
        id: 'reduce-allocations',
        priority: 'medium',
        cause: 'gc-pressure',
        title: '降低 GC 压力',
        action: '减少热路径上的临时对象分配：复用对象池/类型化数组，避免在 rAF 回调中创建闭包和大数组；检查事件监听与定时器是否泄漏。'
      };
    }
  },
  {
    when: function (s) { return (s.causeCounts['resource-loading'] || 0) > 0; },
    suggest: function () {
      return {
        id: 'optimize-resources',
        priority: 'medium',
        cause: 'resource-loading',
        title: '优化资源加载与解码',
        action: '大图先压缩/转 WebP 并指定宽高，用 decoding="async"；脚本加 defer/async；关键资源 preload，非关键资源懒加载。'
      };
    }
  },
  {
    when: function (s) { return (s.causeCounts['input-delay'] || 0) > 0; },
    suggest: function () {
      return {
        id: 'reduce-input-delay',
        priority: 'medium',
        cause: 'input-delay',
        title: '降低输入延迟',
        action: '输入处理器保持轻量（<8ms），重活推迟到 requestIdleCallback；滚动/触摸监听加 { passive: true }。'
      };
    }
  },
  {
    when: function (s) { return (s.causeCounts['unknown'] || 0) >= 5; },
    suggest: function () {
      return {
        id: 'off-main-thread',
        priority: 'low',
        cause: 'unknown',
        title: '排查主线程外负载',
        action: '掉帧无明确主线程归因：检查 CSS 动画是否走合成器（transform/opacity），减少大面积重绘与滤镜/阴影；用 Chrome DevTools Performance 面板抓取一次轨迹确认 GPU/光栅化耗时。'
      };
    }
  },
  {
    when: function (s) { return s.errors.length > 0; },
    suggest: function (s) {
      return {
        id: 'fix-runtime-errors',
        priority: 'high',
        cause: 'error',
        title: '修复运行时异常（' + s.errors.length + ' 个）',
        action: '未捕获异常会中断当前帧的脚本执行并可能引发连锁掉帧。优先处理：' +
          (s.errors[0] ? s.errors[0].message.slice(0, 80) : '')
      };
    }
  }
];

function rebuildSuggestions() {
  var out = [];
  RULES.forEach(function (rule) {
    try {
      if (rule.when(state)) out.push(rule.suggest(state));
    } catch (e) { /* 单条规则异常不影响整体 */ }
  });
  var order = { high: 0, medium: 1, low: 2 };
  out.sort(function (a, b) { return order[a.priority] - order[b.priority]; });
  state.suggestions = out;
}

/* ---------------- 批处理入口 ---------------- */

function processBatch(batch) {
  state.refreshRate = batch.refreshRate || state.refreshRate;
  state.frameBudget = batch.frameBudget || state.frameBudget;
  var budget = state.frameBudget;
  var dropThreshold = budget * DROP_FACTOR;

  // 帧统计
  var frames = batch.frames || [];
  var batchDropped = 0;
  frames.forEach(function (f) {
    state.totalFrames++;
    state.frameTimeSum += f.d;
    if (f.d > state.worstFrame) state.worstFrame = f.d;
    if (f.d > dropThreshold) {
      state.droppedFrames++;
      batchDropped++;
      var attr = attributeDrop(f.t - f.d, f.t, {
        longTasks: state.longTasks.concat(batch.longTasks || []),
        measures: batch.measures || [],
        resources: batch.resources || [],
        memory: state.memory.concat(batch.memory || [])
      });
      state.drops.push({
        t: f.t, frameTime: Math.round(f.d * 10) / 10,
        budget: Math.round(budget * 10) / 10,
        cause: attr.cause, detail: attr.detail, confidence: attr.confidence
      });
      if (state.drops.length > MAX_EVENTS) state.drops.shift();
      state.causeCounts[attr.cause] = (state.causeCounts[attr.cause] || 0) + 1;
    }
  });

  // FPS 采样（本批平均）
  if (frames.length) {
    var span = frames[frames.length - 1].t - frames[0].t;
    if (span > 0) {
      state.fpsSamples.push({ t: batch.ts, fps: Math.round(frames.length / (span / 1000)) });
      if (state.fpsSamples.length > 240) state.fpsSamples.shift();
    }
  }

  (batch.longTasks || []).forEach(function (lt) {
    state.longTasks.push(lt);
    if (state.longTasks.length > 500) state.longTasks.shift();
  });
  (batch.memory || []).forEach(function (m) {
    state.memory.push(m);
    if (state.memory.length > 600) state.memory.shift();
  });
  (batch.errors || []).forEach(function (e) {
    e.id = state.errors.length + 1;
    state.errors.push(e);
    if (state.errors.length > 200) state.errors.shift();
  });

  rebuildSuggestions();
  return snapshot(batch);
}

function snapshot(batch) {
  var avgFrame = state.totalFrames ? state.frameTimeSum / state.totalFrames : 0;
  var fps = avgFrame > 0 ? Math.min(state.refreshRate, 1000 / avgFrame) : state.refreshRate;
  var dropRate = state.totalFrames ? state.droppedFrames / state.totalFrames : 0;
  return {
    type: 'snapshot',
    fps: Math.round(fps * 10) / 10,
    refreshRate: state.refreshRate,
    frameBudget: Math.round(state.frameBudget * 100) / 100,
    avgFrameTime: Math.round(avgFrame * 100) / 100,
    worstFrame: Math.round(state.worstFrame * 10) / 10,
    totalFrames: state.totalFrames,
    droppedFrames: state.droppedFrames,
    dropRate: Math.round(dropRate * 1000) / 10,
    causeCounts: state.causeCounts,
    recentDrops: state.drops.slice(-20).reverse(),
    errors: state.errors.slice(-10).reverse(),
    suggestions: state.suggestions,
    // 本批原始帧（供 Canvas 实时曲线）
    liveFrames: (batch.frames || []).map(function (f) { return Math.round(f.d * 10) / 10; })
  };
}

function buildReport() {
  var snap = snapshot({ frames: [] });
  return {
    type: 'report',
    meta: {
      generatedAt: new Date().toISOString(),
      sessionDurationMs: Date.now() - state.startedAt,
      userAgent: 'worker-context',
      refreshRate: state.refreshRate
    },
    summary: {
      fps: snap.fps,
      avgFrameTime: snap.avgFrameTime,
      worstFrame: snap.worstFrame,
      totalFrames: snap.totalFrames,
      droppedFrames: snap.droppedFrames,
      dropRate: snap.dropRate
    },
    attribution: {
      causeCounts: state.causeCounts,
      drops: state.drops.slice(-100)
    },
    longTasks: state.longTasks.slice(-50),
    errors: state.errors,
    suggestions: state.suggestions,
    fpsTimeline: state.fpsSamples
  };
}

self.onmessage = function (ev) {
  var msg = ev.data || {};
  try {
    if (msg.type === 'batch') {
      self.postMessage(processBatch(msg));
    } else if (msg.type === 'get-report') {
      self.postMessage(buildReport());
    } else if (msg.type === 'reset') {
      state.totalFrames = 0; state.droppedFrames = 0; state.frameTimeSum = 0;
      state.worstFrame = 0; state.drops = []; state.longTasks = [];
      state.errors = []; state.memory = []; state.causeCounts = {};
      state.fpsSamples = []; state.suggestions = [];
      self.postMessage({ type: 'reset-ok' });
    }
  } catch (e) {
    self.postMessage({ type: 'worker-error', message: String(e && e.message || e) });
  }
};
