const ENTRY_TYPES = ['longtask', 'long-animation-frame', 'layout-shift', 'resource', 'paint', 'event', 'measure', 'navigation'];

const DRAW_METHODS = new Set([
  'drawImage', 'fillRect', 'strokeRect', 'fillText', 'strokeText', 'putImageData',
  'fill', 'stroke', 'drawElements', 'drawArrays',
]);

const CANVAS_2D_METHODS = [
  'fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'drawImage',
  'putImageData', 'getImageData', 'fill', 'stroke',
];

const WEBGL_METHODS = [
  'drawElements', 'drawArrays', 'texImage2D', 'texSubImage2D', 'bufferData',
  'uniformMatrix2fv', 'uniformMatrix3fv', 'uniformMatrix4fv',
];

function entryData(type, entry) {
  const base = { name: entry.name, entryType: entry.entryType || type, start: entry.startTime, duration: entry.duration || 0 };
  if (type === 'long-animation-frame') {
    return {
      ...base,
      renderStart: entry.renderStart,
      styleAndLayoutStart: entry.styleAndLayoutStart,
      scriptDuration: (entry.scripts || []).reduce((sum, script) => sum + (script.duration || 0), 0),
      styleAndLayoutDuration: Number.isFinite(entry.styleAndLayoutStart)
        ? entry.duration - Math.max(0, entry.styleAndLayoutStart - entry.startTime)
        : 0,
      scripts: (entry.scripts || []).map((script) => ({
        duration: script.duration,
        sourceURL: script.sourceURL,
        sourceFunctionName: script.sourceFunctionName,
        invoker: script.invoker,
        forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration,
      })),
    };
  }
  if (type === 'layout-shift') return { ...base, value: entry.value, hadRecentInput: entry.hadRecentInput };
  if (type === 'longtask') {
    return {
      ...base,
      attribution: (entry.attribution || []).map((item) => ({ name: item.name, containerType: item.containerType })),
    };
  }
  if (type === 'resource') {
    return {
      ...base,
      initiatorType: entry.initiatorType,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      responseEnd: entry.responseEnd,
    };
  }
  if (type === 'event') return { ...base, processingStart: entry.processingStart, processingEnd: entry.processingEnd, cancelable: entry.cancelable };
  if (type === 'measure') return { ...base, detail: entry.detail ? true : false };
  if (type === 'navigation') {
    return {
      ...base,
      domContentLoadedEventEnd: entry.domContentLoadedEventEnd,
      loadEventEnd: entry.loadEventEnd,
      domInteractive: entry.domInteractive,
      responseEnd: entry.responseEnd,
    };
  }
  return base;
}

export class PerformanceCollector {
  constructor(options = {}) {
    this.targetFps = options.targetFps || 60;
    this.maxBatch = options.maxBatch || 20;
    this.worker = options.worker;
    this.running = false;
    this.observers = [];
    this.frames = [];
    this.pendingEntries = {
      long: [],
      loaf: [],
      layoutShift: [],
      resource: [],
      paint: [],
      event: [],
      measure: [],
      navigation: [],
    };
    this.pendingMap = {
      longtask: 'long',
      'long-animation-frame': 'loaf',
      'layout-shift': 'layoutShift',
      resource: 'resource',
      paint: 'paint',
      event: 'event',
      measure: 'measure',
      navigation: 'navigation',
    };
    this.lastFrame = null;
    this.lastHidden = false;
    this.tickCount = 0;
    this.recordCount = 0;
    this.batchCount = 0;
    this.entryFlushCount = 0;
    this.wrapperCount = 0;
    this.rafId = 0;
    this.startedAt = 0;
    this.canvasStats = null;
    this.instrumented = [];
    this.sentWarnings = new Set();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.tickCount = 0;
    this.recordCount = 0;
    this.batchCount = 0;
    this.entryFlushCount = 0;
    this.sentWarnings = new Set();
    this.lastHidden = document.hidden;
    this.installObservers();
    this.instrumentCanvas();
    this.wrapperCount = this.instrumented.length;
    document.addEventListener('visibilitychange', this.handleVisibility, { passive: true });
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    for (const observer of this.observers) observer.disconnect();
    this.observers = [];
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.restoreCanvas();
    this.flushEntries();
    this.flushFrames();
  }

  handleVisibility = () => {
    this.worker?.postMessage({
      type: 'warning',
      payload: { code: document.hidden ? 'page-hidden' : 'page-visible', message: document.hidden ? '页面切换到后台，帧数据可能受节流影响' : '页面恢复前台' },
    });
  };

  installObservers() {
    if (typeof PerformanceObserver === 'undefined') {
      this.warn('observer-unavailable', '当前浏览器不支持 PerformanceObserver，将仅使用 RAF 和 Canvas 指标。');
      return;
    }

    for (const type of ENTRY_TYPES) {
      try {
        const observer = new PerformanceObserver((list) => {
          const key = this.pendingMap[type];
          for (const entry of list.getEntries()) {
            this.pendingEntries[key].push(entryData(type, entry));
          }
        });
        observer.observe({ type, buffered: true });
        this.observers.push(observer);
      } catch {
        this.warn('observer-unsupported', `${type} 类型不受支持，已自动降级。`);
      }
    }
  }

  instrumentCanvas() {
    const targets = [
      [globalThis.CanvasRenderingContext2D?.prototype, CANVAS_2D_METHODS, false],
      [globalThis.WebGLRenderingContext?.prototype, WEBGL_METHODS, true],
      [globalThis.WebGL2RenderingContext?.prototype, WEBGL_METHODS, true],
    ].filter(([prototype]) => prototype);

    for (const [prototype, methods, isWebGl] of targets) {
      const wrappedMethods = new Set();
      for (const method of new Set(methods)) {
        if (typeof prototype[method] !== 'function') continue;
        const wrapKey = `${prototype.constructor?.name || 'context'}.${method}`;
        if (wrappedMethods.has(wrapKey)) continue;
        const original = prototype[method];
        wrappedMethods.add(wrapKey);
        const tracked = new Proxy(original, {
          apply: (target, context, args) => {
            this.recordCanvasCall(method, args, context, isWebGl);
            return Reflect.apply(target, context, args);
          },
        });
        prototype[method] = tracked;
        this.instrumented.push([prototype, method, original]);
      }
    }

    if (globalThis.HTMLCanvasElement?.prototype && typeof HTMLCanvasElement.prototype.getContext === 'function') {
      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = new Proxy(originalGetContext, {
        apply: (target, canvas, args) => {
          const context = Reflect.apply(target, canvas, args);
          if (context && !canvas.__perfListenersBound && typeof canvas.addEventListener === 'function') {
            canvas.addEventListener('webglcontextlost', () => {
              this.ensureCanvasStats().contextLost += 1;
              this.warn('webgl-context-lost', '检测到 WebGL 上下文丢失。');
            });
            canvas.addEventListener('webglcontextrestored', () => {
              this.ensureCanvasStats().contextRestored += 1;
            });
            Object.defineProperty(canvas, '__perfListenersBound', { value: true });
          }
          return context;
        },
      });
      this.instrumented.push([HTMLCanvasElement.prototype, 'getContext', originalGetContext]);
    }
  }

  restoreCanvas() {
    for (const [target, key, value] of this.instrumented.reverse()) {
      try {
        target[key] = value;
      } catch {
        Object.defineProperty(target, key, { value, configurable: true, writable: true });
      }
    }
    this.instrumented = [];
  }

  ensureCanvasStats() {
    if (!this.canvasStats) {
      this.canvasStats = { calls: 0, drawCalls: 0, pixelsPainted: 0, texBytes: 0, buffers: 0, contextLost: 0, contextRestored: 0, drawImageUnknown: 0, texUploadUnknown: 0 };
    }
    return this.canvasStats;
  }

  recordCanvasCall(method, args, context, isWebGl) {
    if (!this.running || context.canvas?.__perfIgnore) return;
    this.recordCount += 1;
    const stats = this.ensureCanvasStats();
    stats.calls += 1;
    if (DRAW_METHODS.has(method)) stats.drawCalls += 1;

    if (method === 'fillRect' || method === 'strokeRect') {
      stats.pixelsPainted += Math.abs((Number(args[2]) || 0) * (Number(args[3]) || 0));
    }
    if (method === 'drawImage' && args[0]) {
      try {
        const width = args.length === 9 ? args[5] : args.length === 5 ? args[3] : args[0].width;
        const height = args.length === 9 ? args[6] : args.length === 5 ? args[4] : args[0].height;
        stats.pixelsPainted += Math.abs((Number(width) || 0) * (Number(height) || 0));
      } catch {
        stats.drawImageUnknown += 1;
      }
    }
    if (isWebGl && (method === 'texImage2D' || method === 'texSubImage2D')) {
      try {
        const source = args[args.length - 1];
        const pixels = source?.width && source?.height
          ? source.width * source.height * 4
          : Number(args[3]) && Number(args[4]) ? Number(args[3]) * Number(args[4]) * 4 : 0;
        stats.texBytes += pixels;
      } catch {
        stats.texUploadUnknown += 1;
      }
    }
    if (isWebGl && method === 'bufferData') stats.buffers += 1;
  }

  tick = (timestamp) => {
    if (!this.running) return;
    const now = performance.now();
    if (!this.lastFrame) {
      this.lastFrame = { start: now, end: now };
      this.lastHidden = document.hidden;
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    this.tickCount += 1;
    const start = this.lastFrame ? this.lastFrame.end : now;
    const frame = {
      start,
      end: now,
      timestamp,
      duration: this.lastFrame ? now - this.lastFrame.end : 1000 / this.targetFps,
      targetDuration: 1000 / this.targetFps,
      hidden: this.lastHidden,
    };
    if (this.canvasStats) {
      frame.canvas = { ...this.canvasStats };
      this.canvasStats = null;
    }
    if (frame.duration > 1000) {
      this.warn('frame-gap', `检测到 ${Math.round(frame.duration)}ms 帧间隔，可能包含页面挂起或长任务。`);
    }

    this.frames.push(frame);
    this.lastFrame = { start: frame.start, end: now };
    this.lastHidden = document.hidden;
    if (this.frames.length >= this.maxBatch) this.flushFrames();
    this.flushEntries();
    this.rafId = requestAnimationFrame(this.tick);
  };

  flushFrames() {
    if (!this.frames.length) return;
    this.worker?.postMessage({ type: 'batch', payload: { frames: this.frames } }, []);
    this.batchCount += 1;
    this.frames = [];
  }

  flushEntries() {
    const entries = Object.fromEntries(Object.entries(this.pendingEntries).filter(([, values]) => values.length));
    if (!Object.keys(entries).length) return;
    this.worker?.postMessage({ type: 'entries', payload: { entries } });
    this.entryFlushCount += 1;
    for (const key of Object.keys(this.pendingEntries)) this.pendingEntries[key] = [];
  }

  analyze() {
    this.stop();
    this.worker?.postMessage({
      type: 'analyze',
      payload: {
        startedAt: this.startedAt,
        endedAt: Date.now(),
        collectorOverhead: {
          canvasWrappersInstalled: this.wrapperCount,
          canvasCalls: this.recordCount,
          rAFTicks: this.tickCount,
          frameBatches: this.batchCount,
          entryFlushes: this.entryFlushCount,
        },
      },
    });
  }

  warn(code, message) {
    const key = `${code}:${message}`;
    if (this.sentWarnings.has(key)) return;
    this.sentWarnings.add(key);
    this.worker?.postMessage({ type: 'warning', payload: { code, message } });
    if (this.onWarning) this.onWarning({ code, message });
  }
}
