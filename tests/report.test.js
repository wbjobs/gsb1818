import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Attributor } from '../src/attribution.js';
import { buildCsv } from '../src/report.js';

test('CSV report contains frame timing and attributed cause', () => {
  const analyzer = new Attributor();
  analyzer.addEntry('long', { name: 'unknown', start: 0, end: 100, duration: 100 });
  analyzer.addFrame({ start: 0, end: 100, duration: 100, targetDuration: 16.67, hidden: false });
  const report = analyzer.analyze();
  const csv = buildCsv(report);

  assert.match(csv, /100\.00/);
  assert.match(csv, /主线程长任务/);
});
