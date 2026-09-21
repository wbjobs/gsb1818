import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PerformanceCollector } from '../src/collector.js';

class FakeContext {
  constructor(canvas) {
    this.canvas = canvas;
  }

  fillRect() {}
}

class FakeCanvas {
  constructor() {
    this.__perfIgnore = false;
  }

  getContext() {
    return new FakeContext(this);
  }
}

test('collects canvas calls and sends frame batches to worker', async () => {
  const messages = [];
  const rafQueue = [];
  let time = 100;
  const originalFillRect = FakeContext.prototype.fillRect;
  const originalGlobals = {
    HTMLCanvasElement: globalThis.HTMLCanvasElement,
    CanvasRenderingContext2D: globalThis.CanvasRenderingContext2D,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    performance: globalThis.performance,
    PerformanceObserver: globalThis.PerformanceObserver,
    document: globalThis.document,
  };

  globalThis.HTMLCanvasElement = FakeCanvas;
  globalThis.CanvasRenderingContext2D = FakeContext;
  globalThis.requestAnimationFrame = (callback) => rafQueue.push(callback);
  globalThis.cancelAnimationFrame = () => {};
  globalThis.performance = { now: () => time };
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };

  try {
    const collector = new PerformanceCollector({
      worker: { postMessage: (message) => messages.push(message) },
      maxBatch: 2,
    });
    collector.start();
    const canvas = new FakeCanvas();
    const context = canvas.getContext();

    time = 116;
    rafQueue.shift()(time);
    context.fillRect(0, 0, 10, 10);
    time = 132;
    rafQueue.shift()(time);

    collector.stop();
    assert.ok(messages.some((message) => message.type === 'batch'));
    const batch = messages.find((message) => message.type === 'batch');
    assert.equal(batch.payload.frames.length, 1);
    assert.equal(batch.payload.frames[0].canvas.drawCalls, 1);
    assert.equal(FakeContext.prototype.fillRect, originalFillRect);
  } finally {
    Object.assign(globalThis, originalGlobals);
  }
});
