import { ADVICE, CAUSE_LABEL, clamp, round, shortName, summarize } from './utils.js';

const CAUSE_PRIORITY = [
  'background_throttle',
  'forced_layout',
  'layout_shift',
  'gc',
  'webgl_upload',
  'canvas_overdraw',
  'canvas',
  'resource',
  'long_task',
  'animation_frame',
  'script',
  'paint',
  'renderer_unknown',
  'unknown',
];

const overlap = (entry, frame) => entry.start < frame.end && entry.end > frame.start;

function topItems(map, keyFn, limit = 5) {
  return [...map.values()]
    .sort((a, b) => b.count - a.count || b.duration - a.duration)
    .slice(0, limit)
    .map(keyFn);
}

export class Attributor {
  constructor(options = {}) {
    this.targetFps = options.targetFps || 60;
    this.maxFrames = options.maxFrames || 3600;
    this.frames = [];
    this.entries = {
      long: [],
      loaf: [],
      layoutShift: [],
      resource: [],
      paint: [],
      event: [],
      measure: [],
      navigation: [],
    };
    this.scriptHotspots = new Map();
    this.canvasTotals = {
      calls: 0,
      drawCalls: 0,
      pixelsPainted: 0,
      texBytes: 0,
      buffers: 0,
      contextLost: 0,
      contextRestored: 0,
    };
    this.warnings = [];
  }

  addFrame(frame) {
    this.frames.push(frame);
    if (frame.canvas) {
      for (const key of ['calls', 'drawCalls', 'pixelsPainted', 'texBytes', 'buffers', 'contextLost', 'contextRestored']) {
        this.canvasTotals[key] += frame.canvas[key] || 0;
      }
    }
    if (this.frames.length > this.maxFrames) {
      this.frames.splice(0, this.frames.length - this.maxFrames);
    }
  }

  addEntry(type, entry) {
    if (!this.entries[type]) return;
    this.entries[type].push(entry);
    if (this.entries[type].length > 1500) this.entries[type].shift();
    if ((type === 'long' || type === 'loaf') && entry.scripts) {
      for (const script of entry.scripts) {
        const source = script.sourceURL || script.sourceFunctionName || 'anonymous';
        const key = `${source}@${script.sourceFunctionName || script.invoker || 'anonymous'}`;
        const item = this.scriptHotspots.get(key) || {
          key,
          source,
          name: script.sourceFunctionName || script.invoker || 'anonymous',
          count: 0,
          duration: 0,
          forcedStyleAndLayoutDuration: 0,
        };
        item.count += 1;
        item.duration += script.duration || 0;
        item.forcedStyleAndLayoutDuration += script.forcedStyleAndLayoutDuration || 0;
        this.scriptHotspots.set(key, item);
      }
    }
  }

  addWarning(code, message) {
    this.warnings.push({ code, message, at: Date.now() });
  }

  attributeFrame(frame) {
    if (frame.hidden) {
      frame.causes = ['background_throttle'];
      frame.primary = 'background_throttle';
      return frame;
    }

    const budget = frame.targetDuration || 1000 / this.targetFps;
    const longEntries = this.entries.long.filter((entry) => overlap(entry, frame));
    const loafEntries = this.entries.loaf.filter((entry) => overlap(entry, frame));
    const shiftEntries = this.entries.layoutShift.filter((entry) => overlap(entry, frame));
    const resourceEntries = this.entries.resource.filter((entry) => overlap(entry, frame) && entry.duration > Math.min(50, budget));
    const paintEntries = this.entries.paint.filter((entry) => overlap(entry, frame));
    const causes = new Set();
    const slowFrame = frame.duration > budget * 1.5;

    if (!slowFrame) {
      frame.causes = [];
      frame.primary = null;
      frame.evidence = {
        longTasks: longEntries.length,
        animationFrames: loafEntries.length,
        layoutShifts: shiftEntries.length,
        slowResources: resourceEntries.length,
        paints: paintEntries.length,
        canvas: frame.canvas || {},
      };
      return frame;
    }

    for (const loaf of loafEntries) {
      const scripts = loaf.scripts || [];
      if (scripts.some((script) => (script.forcedStyleAndLayoutDuration || 0) > 4)) causes.add('forced_layout');
      if ((loaf.styleAndLayoutDuration || 0) > budget * 0.4) causes.add('forced_layout');
      if (loaf.duration > budget) causes.add('animation_frame');
      if (scripts.some((script) => (script.duration || 0) > budget * 0.5)) causes.add('animation_frame');
      if ((loaf.scriptDuration || 0) > budget * 0.5) causes.add('script');
    }

    if (longEntries.length && !loafEntries.length) {
      causes.add('long_task');
    }
    if (longEntries.some((entry) => /GC|garbage|collect/i.test(`${entry.name || ''} ${entry.attribution?.name || ''}`))) {
      causes.add('gc');
    }
    if (shiftEntries.some((entry) => (entry.value || 0) > 0.05)) causes.add('layout_shift');

    const canvas = frame.canvas || {};
    if (canvas.texBytes > 2 * 1024 * 1024 || canvas.buffers > 20) causes.add('webgl_upload');
    if (canvas.drawCalls > 180 || canvas.pixelsPainted > 38_400_000 || canvas.calls > 600) causes.add('canvas');
    if (canvas.pixelsPainted > this.viewportPixels() * 3 || canvas.drawCalls > 300) causes.add('canvas_overdraw');
    if (canvas.contextLost) causes.add('canvas');
    if (resourceEntries.length > 3) causes.add('resource');
    if (paintEntries.length) causes.add('paint');

    if (!causes.size && longEntries.length) causes.add('long_task');
    if (!causes.size && frame.duration > budget * 3) causes.add('renderer_unknown');
    if (!causes.size && frame.duration > budget * 1.5) causes.add('unknown');

    frame.causes = CAUSE_PRIORITY.filter((cause) => causes.has(cause));
    frame.primary = frame.causes[0] || null;
    frame.evidence = {
      longTasks: longEntries.length,
      animationFrames: loafEntries.length,
      layoutShifts: shiftEntries.length,
      slowResources: resourceEntries.length,
      paints: paintEntries.length,
      canvas,
    };
    return frame;
  }

  viewportPixels() {
    return globalThis.innerWidth && globalThis.innerHeight ? globalThis.innerWidth * globalThis.innerHeight : 1920 * 1080;
  }

  analyze(meta = {}) {
    const frames = this.frames.map((frame) => this.attributeFrame({ ...frame, canvas: frame.canvas ? { ...frame.canvas } : undefined }));
    const visibleFrames = frames.filter((frame) => !frame.hidden);
    const durations = visibleFrames.map((frame) => frame.duration).filter(Number.isFinite);
    const frameSummary = summarize(durations);
    const totalDuration = visibleFrames.reduce((sum, frame) => sum + frame.duration, 0) || 1;
    const expectedDuration = visibleFrames.reduce((sum, frame) => sum + (frame.targetDuration || 1000 / this.targetFps), 0);
    const dropped = visibleFrames.reduce((sum, frame) => sum + Math.max(0, Math.round(frame.duration / (frame.targetDuration || 1000 / this.targetFps)) - 1), 0);
    const slowFrames = visibleFrames.filter((frame) => frame.duration > (frame.targetDuration || 1000 / this.targetFps) * 1.5);
    const severeFrames = visibleFrames.filter((frame) => frame.duration > (frame.targetDuration || 1000 / this.targetFps) * 3);
    const causeStats = new Map();

    for (const frame of slowFrames) {
      for (const cause of frame.causes || []) {
        const item = causeStats.get(cause) || { cause, count: 0, frames: 0, duration: 0, dropped: 0 };
        item.count += 1;
        item.frames += 1;
        item.duration += frame.duration;
        item.dropped += Math.max(0, Math.round(frame.duration / (frame.targetDuration || 1000 / this.targetFps)) - 1);
        causeStats.set(cause, item);
      }
    }

    const stats = [...causeStats.values()]
      .sort((a, b) => b.duration - a.duration)
      .map((item) => {
        const example = slowFrames.find((frame) => (frame.causes || []).includes(item.cause));
        return {
          ...item,
          label: CAUSE_LABEL[item.cause] || item.cause,
          ratio: round((item.duration / totalDuration) * 100),
          evidence: example?.evidence || null,
          advice: ADVICE[item.cause] || ADVICE.unknown,
        };
      });

    const longTasks = this.entries.long;
    const loaf = this.entries.loaf;
    const firstPaint = this.entries.paint.find((entry) => entry.name === 'first-contentful-paint');
    const navigation = this.entries.navigation[0] || null;
    const fps = visibleFrames.length ? visibleFrames.length / (totalDuration / 1000) : 0;
    const jankRate = visibleFrames.length ? slowFrames.length / visibleFrames.length : 0;
    const severeRate = visibleFrames.length ? severeFrames.length / visibleFrames.length : 0;
    const fpsScore = clamp((fps / this.targetFps) * 55, 0, 55);
    const jankScore = (1 - clamp(jankRate, 0, 1)) * 25;
    const stabilityScore = (1 - clamp(longTasks.length / Math.max(1, visibleFrames.length / 10), 0, 1)) * 10;
    const severeScore = (1 - clamp(severeRate, 0, 1)) * 10;
    const score = Math.round(fpsScore + jankScore + stabilityScore + severeScore);
    const hasData = visibleFrames.length > 0;

    return {
      meta: {
        url: globalThis.location?.href || meta.url || '',
        userAgent: globalThis.navigator?.userAgent || meta.userAgent || '',
      },
      startedAt: meta.startedAt || frames[0]?.start || Date.now(),
      endedAt: meta.endedAt || frames.at(-1)?.end || Date.now(),
      targetFps: this.targetFps,
      score: hasData ? score : null,
      rating: !hasData ? '暂无数据' : score >= 85 ? '良好' : score >= 70 ? '可接受' : score >= 50 ? '需要优化' : '严重卡顿',
      metrics: {
        fps: round(fps),
        observedFrames: visibleFrames.length,
        droppedFrames: dropped,
        expectedFrames: Math.round(expectedDuration / (1000 / this.targetFps)),
        slowFrames: slowFrames.length,
        severeFrames: severeFrames.length,
        jankRate: round(jankRate * 100),
        severeRate: round(severeRate * 100),
        longTasks: longTasks.length,
        animationFrames: loaf.length,
        totalBlockingTime: round(longTasks.reduce((sum, entry) => sum + Math.max(0, entry.duration - 50), 0)),
        firstContentfulPaint: firstPaint ? round(firstPaint.start) : null,
        domInteractive: navigation?.domInteractive ? round(navigation.domInteractive) : null,
        loadComplete: navigation?.loadEventEnd ? round(navigation.loadEventEnd) : null,
        collectorOverhead: meta.collectorOverhead || null,
      },
      frameSummary,
      attribution: stats,
      hotspots: topItems(this.scriptHotspots, (item) => ({
        name: item.name,
        source: shortName(item.source),
        sourceUrl: item.source,
        count: item.count,
        duration: round(item.duration),
        forcedLayout: round(item.forcedStyleAndLayoutDuration),
        advice: ADVICE.script,
      })),
      canvasTotals: Object.fromEntries(Object.entries(this.canvasTotals).map(([key, value]) => [key, round(value, 0)])),
      entries: this.entries,
      frames: frames.slice(-600),
      warnings: this.warnings,
      generatedAt: new Date().toISOString(),
    };
  }
}
