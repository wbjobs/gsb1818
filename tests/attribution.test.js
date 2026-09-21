import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Attributor } from '../src/attribution.js';

test('identifies a long main-thread task as the frame cause', () => {
  const analyzer = new Attributor();
  analyzer.addEntry('long', { name: 'unknown', start: 10, end: 135, duration: 125 });
  analyzer.addFrame({ start: 0, end: 135, duration: 135, targetDuration: 16.67, hidden: false });
  const report = analyzer.analyze();
  assert.equal(report.frames[0].primary, 'long_task');
  assert.ok(report.attribution.some((item) => item.cause === 'long_task'));
});

test('attributes excessive canvas draw calls and gives actionable advice', () => {
  const analyzer = new Attributor();
  analyzer.addFrame({
    start: 0,
    end: 50,
    duration: 50,
    targetDuration: 16.67,
    hidden: false,
    canvas: { calls: 700, drawCalls: 220, pixelsPainted: 20_000_000, texBytes: 0, buffers: 0, contextLost: 0, contextRestored: 0 },
  });
  const report = analyzer.analyze();
  assert.ok(report.frames[0].causes.includes('canvas'));
  assert.match(report.attribution.find((item) => item.cause === 'canvas').advice, /离屏/);
});

test('marks hidden frames as background throttling', () => {
  const analyzer = new Attributor();
  analyzer.addFrame({ start: 0, end: 1000, duration: 1000, targetDuration: 16.67, hidden: true });
  const report = analyzer.analyze();
  assert.equal(report.frames[0].primary, 'background_throttle');
});

test('flags forced layout from long animation frame scripts', () => {
  const analyzer = new Attributor();
  analyzer.addEntry('loaf', {
    name: 'animation-frame',
    start: 0,
    end: 60,
    duration: 60,
    renderStart: 55,
    styleAndLayoutStart: 40,
    scripts: [{ duration: 40, forcedStyleAndLayoutDuration: 20, sourceURL: 'app.js', sourceFunctionName: 'update' }],
  });
  analyzer.addFrame({ start: 0, end: 60, duration: 60, targetDuration: 16.67, hidden: false });
  const report = analyzer.analyze();
  assert.ok(report.frames[0].causes.includes('forced_layout'));
  assert.equal(report.hotspots[0].source, 'app.js');
});

test('does not score an empty collection as severe jank', () => {
  const report = new Attributor().analyze();
  assert.equal(report.rating, '暂无数据');
  assert.equal(report.score, null);
});
