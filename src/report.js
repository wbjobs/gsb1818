import { CAUSE_LABEL, download, escapeHtml } from './utils.js';

function timestamp() {
  return new Date().toISOString().replaceAll(':', '-').replace(/\..+/, '');
}

export function exportJson(report) {
  download(`performance-report-${timestamp()}.json`, JSON.stringify(report, null, 2), 'application/json');
}

export function buildCsv(report) {
  const header = ['frameStart', 'frameEnd', 'duration', 'fpsImpact', 'hidden', 'primaryCause', 'allCauses'];
  const rows = report.frames.map((frame) => [
    frame.start.toFixed(2),
    frame.end.toFixed(2),
    frame.duration.toFixed(2),
    (1000 / frame.duration).toFixed(2),
    frame.hidden ? 'yes' : 'no',
    frame.primary ? CAUSE_LABEL[frame.primary] || frame.primary : '',
    (frame.causes || []).map((cause) => CAUSE_LABEL[cause] || cause).join('|'),
  ]);
  return [header, ...rows].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n');
}

export function exportCsv(report) {
  const csv = buildCsv(report);
  download(`performance-frames-${timestamp()}.csv`, `\uFEFF${csv}`, 'text/csv');
}

function metricRows(report) {
  const labels = {
    fps: '平均 FPS',
    observedFrames: '可见帧数',
    droppedFrames: '估算掉帧',
    expectedFrames: '期望帧数',
    slowFrames: '慢帧（>1.5 帧预算）',
    severeFrames: '严重卡顿帧（>3 帧预算）',
    jankRate: '慢帧率(%)',
    severeRate: '严重卡顿率(%)',
    longTasks: '长任务数',
    animationFrames: '长动画帧数',
    totalBlockingTime: '主线程阻塞时间(ms)',
    firstContentfulPaint: 'FCP(ms)',
    domInteractive: 'DOM 可交互(ms)',
    loadComplete: 'Load 完成(ms)',
    collectorOverhead: '采集器开销',
  };
  const rows = Object.entries(report.metrics).map(([key, value]) => {
    const rendered = key === 'collectorOverhead' && value
      ? `${value.canvasCalls} 次 Canvas 调用 / ${value.frameBatches} 个帧批次 / ${value.entryFlushes} 次条目批次`
      : escapeHtml(value);
    return `<tr><th>${escapeHtml(labels[key] || key)}</th><td>${rendered}</td></tr>`;
  });
  rows.push(
    `<tr><th>采集开始</th><td>${escapeHtml(new Date(report.startedAt).toLocaleString())}</td></tr>`,
    `<tr><th>采集结束</th><td>${escapeHtml(new Date(report.endedAt).toLocaleString())}</td></tr>`,
  );
  rows.push(...Object.entries(report.frameSummary).map(([key, value]) => `<tr><th>帧时长 ${key} (ms)</th><td>${escapeHtml(value)}</td></tr>`));
  return rows.join('');
}

function causeRows(report) {
  return report.attribution.map((item) => `
    <tr>
      <td>${escapeHtml(item.label)}</td>
      <td>${escapeHtml(item.frames)}</td>
      <td>${escapeHtml(item.ratio)}%</td>
      <td>${escapeHtml(item.dropped)}</td>
      <td>${escapeHtml(formatEvidence(item))}</td>
      <td>${escapeHtml(item.advice)}</td>
    </tr>`).join('');
}

function formatEvidence(item) {
  const evidence = item.evidence;
  if (!evidence) return '详见帧数据';
  if (['canvas', 'canvas_overdraw', 'webgl_upload'].includes(item.cause)) {
    return `draw=${evidence.canvas?.drawCalls || 0}, calls=${evidence.canvas?.calls || 0}, pixels=${evidence.canvas?.pixelsPainted || 0}`;
  }
  return `long=${evidence.longTasks}, loaf=${evidence.animationFrames}, shift=${evidence.layoutShifts}, resource=${evidence.slowResources}`;
}

function hotspotRows(report) {
  return report.hotspots.map((item) => `
    <tr>
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.source)}</td>
      <td>${escapeHtml(item.count)}</td>
      <td>${escapeHtml(item.duration)}ms</td>
      <td>${escapeHtml(item.forcedLayout)}ms</td>
    </tr>`).join('') || '<tr><td colspan="5">未捕获脚本热点；浏览器可能不支持 Long Animation Frames。</td></tr>';
}

export function exportHtml(report) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>性能分析报告</title>
  <style>
    body { margin: 0; padding: 32px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f8fb; color: #172033; }
    main { max-width: 1100px; margin: auto; }
    section { background: white; border: 1px solid #dfe5ef; border-radius: 14px; padding: 20px; margin-bottom: 18px; }
    h1 { margin: 0 0 8px; } h2 { margin: 0 0 14px; font-size: 18px; }
    .score { display: inline-flex; align-items: center; gap: 12px; padding: 14px 18px; border-radius: 12px; background: #eef5ff; }
    .score strong { font-size: 36px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; border-bottom: 1px solid #e7ebf2; padding: 9px 8px; vertical-align: top; }
    th { width: 180px; color: #536071; font-weight: 600; }
    .muted { color: #657085; }
  </style>
</head>
<body><main>
  <h1>性能分析报告</h1>
  <p class="muted">生成于 ${escapeHtml(report.generatedAt)} · ${escapeHtml(report.meta.url)}</p>
  <section class="score"><strong>${escapeHtml(report.score)}</strong><span>${escapeHtml(report.rating)}<br>目标 ${escapeHtml(report.targetFps)} FPS</span></section>
  <section><h2>核心指标</h2><table>${metricRows(report)}</table></section>
  <section><h2>掉帧归因与建议</h2><table><thead><tr><th>原因</th><th>帧数</th><th>占比</th><th>掉帧</th><th>证据</th><th>可操作建议</th></tr></thead><tbody>${causeRows(report)}</tbody></table></section>
  <section><h2>脚本热点</h2><table><thead><tr><th>函数</th><th>来源</th><th>次数</th><th>耗时</th><th>强制布局</th></tr></thead><tbody>${hotspotRows(report)}</tbody></table></section>
  <section><h2>异常与降级</h2><p>${report.warnings?.length ? report.warnings.map((item) => escapeHtml(item.message)).join('<br>') : '未发现采集异常。'}</p></section>
</main></body></html>`;
  download(`performance-report-${timestamp()}.html`, html, 'text/html');
}
