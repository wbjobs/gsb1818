/**
 * main.js — UI 胶水层
 * 职责：桥接 Monitor ↔ Worker，Canvas 实时帧耗时图，指标面板，演示负载，报告导出
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var liveFrameBuffer = [];   // 最近帧耗时（Canvas 用）
  var MAX_LIVE = 300;
  var worker = null;
  var monitor = null;
  var lastReport = null;

  /* ---------------- 异常提示条 ---------------- */

  function toast(msg, level) {
    var bar = $('toast');
    bar.textContent = msg;
    bar.className = 'show ' + (level || 'warn');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { bar.className = ''; }, 5000);
  }

  /* ---------------- Worker 桥接 ---------------- */

  function initWorker() {
    try {
      worker = new Worker('js/analyzer-worker.js');
    } catch (e) {
      toast('Web Worker 初始化失败：' + e.message + '（分析功能不可用）', 'error');
      return;
    }
    worker.onerror = function (ev) {
      toast('分析 Worker 异常：' + (ev.message || '未知错误'), 'error');
    };
    worker.onmessage = function (ev) {
      var msg = ev.data || {};
      if (msg.type === 'snapshot') {
        renderSnapshot(msg);
      } else if (msg.type === 'report') {
        lastReport = msg;
        PerfReport.exportHTML(msg);
        PerfReport.exportJSON(msg);
        toast('报告已导出（HTML + JSON）', 'ok');
      } else if (msg.type === 'worker-error') {
        toast('分析异常：' + msg.message, 'error');
      } else if (msg.type === 'reset-ok') {
        liveFrameBuffer = [];
        toast('统计已重置', 'ok');
      }
    };
  }

  /* ---------------- 指标渲染 ---------------- */

  var CAUSE_LABELS = {
    'long-task': '长任务阻塞',
    'layout-thrash': '布局抖动',
    'script-measure': '脚本耗时',
    'input-delay': '输入延迟',
    'resource-loading': '资源加载',
    'gc-pressure': 'GC 压力',
    'unknown': '未归因'
  };

  function renderSnapshot(s) {
    $('m-fps').textContent = s.fps;
    $('m-fps').className = 'val ' + (s.fps >= s.refreshRate * 0.9 ? 'good' : s.fps >= s.refreshRate * 0.6 ? 'mid' : 'bad');
    $('m-frame').textContent = s.avgFrameTime + 'ms';
    $('m-worst').textContent = s.worstFrame + 'ms';
    $('m-drops').textContent = s.droppedFrames + ' (' + s.dropRate + '%)';
    $('m-refresh').textContent = s.refreshRate + 'Hz';

    (s.liveFrames || []).forEach(function (d) {
      liveFrameBuffer.push({ d: d, budget: s.frameBudget });
    });
    while (liveFrameBuffer.length > MAX_LIVE) liveFrameBuffer.shift();

    // 归因统计
    var cc = s.causeCounts || {};
    var keys = Object.keys(cc);
    $('cause-list').innerHTML = keys.length
      ? keys.map(function (k) {
          return '<li><span class="tag cause-' + k + '">' + (CAUSE_LABELS[k] || k) +
            '</span><span class="cnt">' + cc[k] + '</span></li>';
        }).join('')
      : '<li class="empty">暂无掉帧</li>';

    // 掉帧明细
    $('drop-list').innerHTML = s.recentDrops.length
      ? s.recentDrops.map(function (d) {
          return '<li><b>' + d.frameTime + 'ms</b> <span class="tag cause-' + d.cause + '">' +
            (CAUSE_LABELS[d.cause] || d.cause) + '</span><br><small>' + escapeHtml(d.detail) +
            '（置信度 ' + Math.round(d.confidence * 100) + '%）</small></li>';
        }).join('')
      : '<li class="empty">暂无掉帧事件</li>';

    // 建议
    $('suggest-list').innerHTML = s.suggestions.length
      ? s.suggestions.map(function (g) {
          return '<li class="pri-' + g.priority + '"><b>[' + g.priority.toUpperCase() + '] ' +
            escapeHtml(g.title) + '</b><br>' + escapeHtml(g.action) + '</li>';
        }).join('')
      : '<li class="empty">性能良好，暂无建议 🎉</li>';

    // 异常
    $('error-list').innerHTML = s.errors.length
      ? s.errors.map(function (e) {
          return '<li><span class="tag err">' + escapeHtml(e.kind) + '</span> ' +
            escapeHtml(e.message) + (e.source ? '<br><small>' + escapeHtml(e.source) + ':' + e.line + '</small>' : '') + '</li>';
        }).join('')
      : '<li class="empty">无运行时异常</li>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ---------------- Canvas 实时帧耗时图 ---------------- */

  function drawLoop() {
    var canvas = $('chart');
    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var budget = liveFrameBuffer.length ? liveFrameBuffer[liveFrameBuffer.length - 1].budget : 16.7;
    var maxMs = Math.max(budget * 4, 50);
    var yOf = function (ms) { return h - (ms / maxMs) * h; };

    // 帧预算线 & 掉帧线
    ctx.strokeStyle = 'rgba(60,180,90,.7)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, yOf(budget)); ctx.lineTo(w, yOf(budget)); ctx.stroke();
    ctx.strokeStyle = 'rgba(220,60,60,.7)';
    ctx.beginPath(); ctx.moveTo(0, yOf(budget * 2)); ctx.lineTo(w, yOf(budget * 2)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#888'; ctx.font = '11px sans-serif';
    ctx.fillText('预算 ' + budget.toFixed(1) + 'ms', 6, yOf(budget) - 4);
    ctx.fillText('掉帧线 ' + (budget * 2).toFixed(1) + 'ms', 6, yOf(budget * 2) - 4);

    // 帧耗时柱状
    var n = liveFrameBuffer.length;
    var bw = w / MAX_LIVE;
    for (var i = 0; i < n; i++) {
      var f = liveFrameBuffer[i];
      var x = w - (n - i) * bw;
      var dropped = f.d > f.budget * 2;
      ctx.fillStyle = dropped ? '#e74c3c' : f.d > f.budget ? '#f39c12' : '#2ecc71';
      var bh = Math.min(f.d, maxMs) / maxMs * h;
      ctx.fillRect(x, h - bh, Math.max(bw - 0.5, 1), bh);
    }
    requestAnimationFrame(drawLoop);
  }

  /* ---------------- 演示负载（验证归因准确性） ---------------- */

  function simulateLongTask() {
    var end = performance.now() + 120;
    while (performance.now() < end) { Math.sqrt(Math.random()); } // 120ms 同步阻塞
  }

  function simulateLayoutThrash() {
    performance.mark('layout-start');
    var el = $('thrash-target');
    for (var i = 0; i < 60; i++) {
      el.style.width = (100 + (i % 10) * 10) + 'px';
      void el.offsetWidth; // 强制同步布局
    }
    performance.mark('layout-end');
    performance.measure('layout-thrash-demo', 'layout-start', 'layout-end');
  }

  function simulateGC() {
    var junk = [];
    for (var i = 0; i < 30; i++) {
      junk.push(new Array(100000).fill(Math.random()));
      if (junk.length > 5) junk.shift();
    }
  }

  function simulateError() {
    setTimeout(function () { throw new Error('演示异常：未捕获的运行时错误'); }, 0);
  }

  function simulateHeavyResource() {
    var img = new Image();
    img.src = 'https://picsum.photos/4000/3000?_=' + Date.now(); // 大图解码
    img.decoding = 'sync';
    img.onload = function () { document.body.appendChild(img); img.remove(); };
    img.onerror = function () { toast('演示资源加载失败（网络受限时属正常）', 'warn'); };
  }

  /* ---------------- 启动 ---------------- */

  function init() {
    initWorker();

    monitor = new PerfMonitor({
      onBatch: function (batch) {
        if (worker) worker.postMessage(batch);
      }
    });
    monitor.onError = function (err) {
      toast('采集器[' + err.phase + ']：' + err.message, 'warn');
    };
    monitor.start();

    $('btn-longtask').onclick = simulateLongTask;
    $('btn-layout').onclick = simulateLayoutThrash;
    $('btn-gc').onclick = simulateGC;
    $('btn-error').onclick = simulateError;
    $('btn-resource').onclick = simulateHeavyResource;
    $('btn-report').onclick = function () {
      if (worker) worker.postMessage({ type: 'get-report' });
      else toast('Worker 不可用，无法生成报告', 'error');
    };
    $('btn-reset').onclick = function () {
      if (worker) worker.postMessage({ type: 'reset' });
    };

    requestAnimationFrame(drawLoop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
