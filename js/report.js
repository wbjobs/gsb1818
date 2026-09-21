/**
 * report.js — 报告生成与导出
 * 支持导出 JSON（原始数据）与 HTML（自包含可视化报告）
 */
(function (global) {
  'use strict';

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function exportJSON(report) {
    download(
      'perf-report-' + Date.now() + '.json',
      JSON.stringify(report, null, 2),
      'application/json'
    );
  }

  function exportHTML(report) {
    var s = report.summary;
    var causeRows = Object.keys(report.attribution.causeCounts).map(function (k) {
      return '<tr><td>' + esc(k) + '</td><td>' + report.attribution.causeCounts[k] + '</td></tr>';
    }).join('');
    var dropRows = report.attribution.drops.slice(-50).reverse().map(function (d) {
      return '<tr><td>' + Math.round(d.t) + '</td><td>' + d.frameTime + '</td><td>' +
        esc(d.cause) + '</td><td>' + esc(d.detail) + '</td><td>' +
        Math.round(d.confidence * 100) + '%</td></tr>';
    }).join('');
    var suggItems = report.suggestions.map(function (g) {
      return '<li class="' + g.priority + '"><b>[' + g.priority.toUpperCase() + '] ' +
        esc(g.title) + '</b><br>' + esc(g.action) + '</li>';
    }).join('');
    var errRows = report.errors.map(function (e) {
      return '<tr><td>' + esc(e.kind) + '</td><td>' + esc(e.message) + '</td><td>' +
        esc(e.source || '') + ':' + (e.line || '') + '</td></tr>';
    }).join('');

    var html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<title>性能报告 ' + esc(report.meta.generatedAt) + '</title>' +
      '<style>body{font-family:system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#222}' +
      'table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border:1px solid #ddd;padding:6px 10px;font-size:14px}' +
      'th{background:#f5f5f5;text-align:left}.cards{display:flex;gap:12px;flex-wrap:wrap}' +
      '.card{border:1px solid #ddd;border-radius:8px;padding:12px 18px;min-width:130px}' +
      '.card b{font-size:22px;display:block}.high{border-left:4px solid #d33}.medium{border-left:4px solid #e90}.low{border-left:4px solid #39c}' +
      'ul{list-style:none;padding:0}li{margin:8px 0;padding:8px 12px;background:#fafafa;border-radius:6px}</style></head><body>' +
      '<h1>前端性能报告</h1>' +
      '<p>生成时间：' + esc(report.meta.generatedAt) + ' ｜ 会话时长：' +
      Math.round(report.meta.sessionDurationMs / 1000) + 's ｜ 屏幕刷新率：' + report.meta.refreshRate + 'Hz</p>' +
      '<div class="cards">' +
      '<div class="card">平均 FPS<b>' + s.fps + '</b></div>' +
      '<div class="card">平均帧耗时<b>' + s.avgFrameTime + 'ms</b></div>' +
      '<div class="card">最差帧<b>' + s.worstFrame + 'ms</b></div>' +
      '<div class="card">掉帧<b>' + s.droppedFrames + ' / ' + s.totalFrames + '</b></div>' +
      '<div class="card">掉帧率<b>' + s.dropRate + '%</b></div></div>' +
      '<h2>掉帧归因统计</h2><table><tr><th>原因</th><th>次数</th></tr>' + (causeRows || '<tr><td colspan="2">无掉帧</td></tr>') + '</table>' +
      '<h2>掉帧明细（最近 50 条）</h2><table><tr><th>时间(ms)</th><th>帧耗时(ms)</th><th>归因</th><th>说明</th><th>置信度</th></tr>' +
      (dropRows || '<tr><td colspan="5">无</td></tr>') + '</table>' +
      '<h2>优化建议</h2><ul>' + (suggItems || '<li>当前无建议，性能良好 🎉</li>') + '</ul>' +
      '<h2>运行时异常（' + report.errors.length + '）</h2>' +
      '<table><tr><th>类型</th><th>信息</th><th>位置</th></tr>' + (errRows || '<tr><td colspan="3">无异常</td></tr>') + '</table>' +
      '</body></html>';

    download('perf-report-' + Date.now() + '.html', html, 'text/html');
  }

  global.PerfReport = { exportJSON: exportJSON, exportHTML: exportHTML };
})(window);
