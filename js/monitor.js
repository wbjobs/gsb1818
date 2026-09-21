/**
 * monitor.js — 性能采集层（主线程）
 * 职责：
 *  1. rAF 帧采样：帧耗时、FPS、掉帧检测
 *  2. PerformanceObserver：longtask / paint / measure / resource / first-input
 *  3. 异常捕获：window.onerror / unhandledrejection / observer 自身异常
 *  4. 内存采样：performance.memory（GC 归因辅助）
 *  5. 批量打包后 postMessage 给分析 Worker，避免高频通信开销
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    sampleInterval: 500,        // 向 Worker 上报的批量间隔 (ms)
    memoryInterval: 1000,       // 内存采样间隔 (ms)
    maxFrameBuffer: 600,        // 主线程帧环形缓冲（约 10s @60fps）
    frameBudgetFallback: 16.7,  // 无法探测刷新率时的帧预算
    longTaskThreshold: 50       // longtask 标准阈值 (ms)
  };

  function now() { return performance.now(); }

  function PerfMonitor(options) {
    this.opts = Object.assign({}, DEFAULTS, options || {});
    this.onBatch = (options && options.onBatch) || null; // function(batch) —— 桥接到 Worker
    this.onError = (options && options.onError) || null;   // function(errInfo) —— 采集器异常提示
    this._running = false;
    this._frames = [];          // 帧耗时环形缓冲
    this._longTasks = [];
    this._measures = [];
    this._resources = [];
    this._paints = [];
    this._errors = [];
    this._memory = [];
    this._observers = [];
    this._rafId = 0;
    this._lastFrameTs = 0;
    this._frameDeltas = [];     // 最近帧间隔，用于估算刷新率
    this._refreshRate = 60;
    this._timers = [];
    this._boundHandlers = [];
  }

  /* ---------------- 生命周期 ---------------- */

  PerfMonitor.prototype.start = function () {
    if (this._running) return;
    this._running = true;
    try {
      this._startFrameLoop();
      this._startObservers();
      this._startErrorHooks();
      this._startMemorySampler();
      this._startBatchTimer();
    } catch (e) {
      this._emitCollectorError('start', e);
    }
  };

  PerfMonitor.prototype.stop = function () {
    this._running = false;
    cancelAnimationFrame(this._rafId);
    this._timers.forEach(clearInterval);
    this._timers = [];
    this._observers.forEach(function (o) { try { o.disconnect(); } catch (e) {} });
    this._observers = [];
    this._boundHandlers.forEach(function (h) {
      global.removeEventListener(h.type, h.fn, h.opt);
    });
    this._boundHandlers = [];
    this._flush(); // 收尾把缓冲发出去
  };

  /* ---------------- 帧采样 ---------------- */

  PerfMonitor.prototype._startFrameLoop = function () {
    var self = this;
    this._lastFrameTs = now();
    function tick(ts) {
      if (!self._running) return;
      var delta = ts - self._lastFrameTs;
      self._lastFrameTs = ts;
      if (delta > 0 && delta < 1000) {
        self._frames.push({ t: ts, d: delta });
        if (self._frames.length > self.opts.maxFrameBuffer) self._frames.shift();
        // 用最近 120 帧中位数估算刷新率（自适应 60/120/144Hz 屏）
        self._frameDeltas.push(delta);
        if (self._frameDeltas.length > 120) self._frameDeltas.shift();
        if (self._frameDeltas.length >= 30) self._estimateRefreshRate();
      }
      self._rafId = requestAnimationFrame(tick);
    }
    this._rafId = requestAnimationFrame(tick);
  };

  PerfMonitor.prototype._estimateRefreshRate = function () {
    var sorted = this._frameDeltas.slice().sort(function (a, b) { return a - b; });
    var median = sorted[Math.floor(sorted.length / 2)];
    if (median > 1) this._refreshRate = Math.round(1000 / median);
  };

  PerfMonitor.prototype.getFrameBudget = function () {
    return 1000 / (this._refreshRate || 60);
  };

  /* ---------------- PerformanceObserver ---------------- */

  PerfMonitor.prototype._observe = function (type, callback, extra) {
    try {
      var supported = PerformanceObserver.supportedEntryTypes || [];
      if (supported.indexOf(type) === -1) {
        this._emitCollectorError('observe', new Error('不支持 entryType: ' + type));
        return;
      }
      var obs = new PerformanceObserver(function (list) {
        try { callback(list.getEntries()); } catch (e) { /* 回调异常不拖垮采集 */ }
      });
      var conf = { type: type, buffered: true };
      if (extra) Object.assign(conf, extra);
      obs.observe(conf);
      this._observers.push(obs);
    } catch (e) {
      // 某些类型（如 longtask 的 buffered）在旧浏览器会抛错，降级为 entryTypes
      try {
        var obs2 = new PerformanceObserver(function (list) {
          try { callback(list.getEntries()); } catch (err) {}
        });
        obs2.observe({ entryTypes: [type] });
        this._observers.push(obs2);
      } catch (e2) {
        this._emitCollectorError('observe:' + type, e2);
      }
    }
  };

  PerfMonitor.prototype._startObservers = function () {
    var self = this;

    this._observe('longtask', function (entries) {
      entries.forEach(function (en) {
        var attribution = [];
        try {
          (en.attribution || []).forEach(function (a) {
            attribution.push({
              name: a.name || '',
              containerType: a.containerType || '',
              containerSrc: a.containerSrc || '',
              containerId: a.containerId || '',
              containerName: a.containerName || ''
            });
          });
        } catch (e) {}
        self._longTasks.push({
          start: en.startTime,
          duration: en.duration,
          name: en.name,
          attribution: attribution
        });
      });
    });

    this._observe('paint', function (entries) {
      entries.forEach(function (en) {
        self._paints.push({ name: en.name, start: en.startTime });
      });
    });

    // 业务可用 performance.measure 打点，用于布局/脚本归因
    this._observe('measure', function (entries) {
      entries.forEach(function (en) {
        self._measures.push({ name: en.name, start: en.startTime, duration: en.duration });
      });
    });

    this._observe('resource', function (entries) {
      entries.forEach(function (en) {
        if (en.duration > 100) { // 只关心慢资源
          self._resources.push({
            name: en.name, start: en.startTime, duration: en.duration,
            type: en.initiatorType, size: en.transferSize || 0
          });
        }
      });
    });

    this._observe('first-input', function (entries) {
      entries.forEach(function (en) {
        self._measures.push({
          name: 'first-input:' + en.name,
          start: en.startTime,
          duration: en.duration
        });
      });
    });
  };

  /* ---------------- 异常捕获 ---------------- */

  PerfMonitor.prototype._startErrorHooks = function () {
    var self = this;
    function onError(ev) {
      self._errors.push({
        kind: 'error',
        message: String(ev.message || 'unknown'),
        source: ev.filename || '',
        line: ev.lineno || 0,
        col: ev.colno || 0,
        stack: ev.error && ev.error.stack ? String(ev.error.stack) : '',
        t: now()
      });
    }
    function onRejection(ev) {
      var r = ev.reason;
      self._errors.push({
        kind: 'unhandledrejection',
        message: r && r.message ? String(r.message) : String(r),
        stack: r && r.stack ? String(r.stack) : '',
        t: now()
      });
    }
    global.addEventListener('error', onError, true);
    global.addEventListener('unhandledrejection', onRejection);
    this._boundHandlers.push({ type: 'error', fn: onError, opt: true });
    this._boundHandlers.push({ type: 'unhandledrejection', fn: onRejection });
  };

  /* ---------------- 内存采样 ---------------- */

  PerfMonitor.prototype._startMemorySampler = function () {
    var self = this;
    if (!performance.memory) return; // 非 Chromium 无此 API，静默跳过
    this._timers.push(setInterval(function () {
      try {
        self._memory.push({ t: now(), used: performance.memory.usedJSHeapSize });
        if (self._memory.length > 120) self._memory.shift();
      } catch (e) {}
    }, this.opts.memoryInterval));
  };

  /* ---------------- 批量上报 ---------------- */

  PerfMonitor.prototype._startBatchTimer = function () {
    var self = this;
    this._timers.push(setInterval(function () { self._flush(); }, this.opts.sampleInterval));
  };

  PerfMonitor.prototype._flush = function () {
    if (!this.onBatch) return;
    var batch = {
      type: 'batch',
      ts: now(),
      refreshRate: this._refreshRate,
      frameBudget: this.getFrameBudget(),
      frames: this._frames.splice(0),
      longTasks: this._longTasks.splice(0),
      measures: this._measures.splice(0),
      resources: this._resources.splice(0),
      paints: this._paints.splice(0),
      errors: this._errors.splice(0),
      memory: this._memory.splice(0)
    };
    try { this.onBatch(batch); } catch (e) { this._emitCollectorError('flush', e); }
  };

  PerfMonitor.prototype._emitCollectorError = function (phase, err) {
    if (this.onError) {
      this.onError({ phase: phase, message: err && err.message ? err.message : String(err) });
    }
  };

  global.PerfMonitor = PerfMonitor;
})(window);
