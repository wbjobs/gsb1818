import { PerformanceCollector } from './collector.js';
import { Attributor } from './attribution.js';
import { exportCsv, exportHtml, exportJson } from './report.js';
import { CAUSE_LABEL, escapeHtml } from './utils.js';

const $ = (selector) => document.querySelector(selector);

const state = {
  collector: null,
  report: null,
  stress: null,
  fallbackAnalyzer: null,
};

const els = {
  start: $('#start'),
  stop: $('#stop'),
  json: $('#exportJson'),
  csv: $('#exportCsv'),
  html: $('#exportHtml'),
  scenario: $('#scenario'),
  applyScenario: $('#applyScenario'),
  clearScenario: $('#clearScenario'),
  fps: $('#fps'),
  dropped: $('#dropped'),
  longTasks: $('#longTasks'),
  status: $('#status'),
  attribution: $('#attribution'),
  hotspots: $('#hotspots'),
  warnings: $('#warnings'),
  chart: $('#chart'),
  demo: $('#demoCanvas'),
};

els.chart.__perfIgnore = true;

const chart = {
  ctx: els.chart.getContext('2d'),
  values: [],
};

function evidenceText(item) {
  const evidence = item.evidence;
  if (!evidence) return '';
  if (item.cause === 'canvas' || item.cause === 'canvas_overdraw' || item.cause === 'webgl_upload') {
    return `证据：绘制 ${evidence.canvas?.drawCalls || 0} 次，调用 ${evidence.canvas?.calls || 0} 次，覆盖 ${Math.round((evidence.canvas?.pixelsPainted || 0) / 10000) / 100} 百万像素`;
  }
  return `证据：长任务 ${evidence.longTasks}，长动画帧 ${evidence.animationFrames}，布局偏移 ${evidence.layoutShifts}，慢资源 ${evidence.slowResources}`;
}

function setStatus(text, tone = 'normal') {
  els.status.textContent = text;
  els.status.dataset.tone = tone;
}

function start() {
  let actualWorker = null;
  state.fallbackAnalyzer = null;
  const fallbackWorker = {
    postMessage: (message) => handleFallbackMessage(message),
  };
  try {
    actualWorker = new Worker('./src/worker.js', { type: 'module' });
    actualWorker.onmessage = handleWorkerMessage;
    actualWorker.onerror = (event) => {
      addWarning('worker-error', `Worker 异常：${event.message || '未知错误'}，已切换到主线程兜底分析。`);
      setStatus('Worker 异常，使用主线程兜底', 'warn');
      state.fallbackAnalyzer = new Attributor({ targetFps: 60, maxFrames: 3600 });
      state.collector.worker = fallbackWorker;
    };
  } catch (error) {
    addWarning('worker-create', `无法创建 Worker：${error.message}，将使用主线程兜底分析。`);
    setStatus('Worker 不可用，使用主线程兜底', 'warn');
  }

  const analysisWorker = actualWorker || fallbackWorker;
  state.collector = new PerformanceCollector({ worker: analysisWorker, targetFps: 60, maxBatch: 5 });
  state.collector.onWarning = ({ message }) => addWarning('collector', message);
  if (!actualWorker) {
    state.fallbackAnalyzer = new Attributor({ targetFps: 60, maxFrames: 3600 });
  }
  state.collector.start();
  els.start.disabled = true;
  els.stop.disabled = false;
  chart.values = [];
  setStatus('正在采集：RAF、PerformanceObserver 与 Canvas 指标实时进入 Worker。', 'good');
}

function handleFallbackMessage(message) {
  if (!state.fallbackAnalyzer) state.fallbackAnalyzer = new Attributor({ targetFps: 60, maxFrames: 3600 });
  const fallback = state.fallbackAnalyzer;
  const { type, payload = {} } = message;
  if (type === 'entries') {
    for (const [entryType, items] of Object.entries(payload.entries || {})) {
      for (const item of items) fallback.addEntry(entryType, item);
    }
  }
  if (type === 'batch') {
    for (const frame of payload.frames || []) fallback.addFrame(frame);
  }
  if (type === 'warning') fallback.addWarning(payload.code, payload.message);
  if (type === 'analyze') renderReport(fallback.analyze(payload));
}

function stop() {
  state.collector?.analyze();
  els.stop.disabled = true;
  setStatus('正在生成归因报告...', 'normal');
  stopScenario();
}

function handleWorkerMessage(event) {
  const { type, payload } = event.data;
  if (type === 'live') renderLive(payload);
  if (type === 'report') renderReport(payload);
  if (type === 'error') {
    addWarning('worker', payload.message);
    setStatus(payload.message, 'bad');
  }
}

function renderLive(live) {
  els.fps.textContent = live.fps;
  els.fps.dataset.tone = live.fps >= 55 ? 'good' : live.fps >= 40 ? 'warn' : 'bad';
  els.dropped.textContent = live.lastFrame?.primary && live.lastFrame.duration > live.lastFrame.targetDuration * 1.5
    ? CAUSE_LABEL[live.lastFrame.primary]
    : '稳定';
  els.longTasks.textContent = live.frames;
  chart.values.push({ fps: live.fps, duration: live.lastFrame?.duration || 16.67, cause: live.lastFrame?.primary || null });
  if (chart.values.length > 120) chart.values.shift();
  drawChart();
}

function drawChart() {
  const ctx = chart.ctx;
  const width = els.chart.width = els.chart.clientWidth * devicePixelRatio;
  const height = els.chart.height = els.chart.clientHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const cssWidth = els.chart.clientWidth;
  const cssHeight = els.chart.clientHeight;
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.strokeStyle = '#d9e1ef';
  ctx.lineWidth = 1;
  for (let y = 0; y <= 4; y++) {
    const yPos = (cssHeight / 4) * y;
    ctx.beginPath();
    ctx.moveTo(0, yPos);
    ctx.lineTo(cssWidth, yPos);
    ctx.stroke();
  }
  const points = chart.values;
  if (!points.length) return;
  const step = cssWidth / Math.max(119, points.length - 1);
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = index * step;
    const y = cssHeight - Math.min(point.fps, 70) / 70 * cssHeight;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#2f6fed';
  ctx.stroke();
}

function renderReport(report) {
  state.report = report;
  els.start.disabled = false;
  [els.json, els.csv, els.html].forEach((button) => button.disabled = false);
  els.fps.textContent = report.metrics.fps;
  els.dropped.textContent = `${report.metrics.droppedFrames} 帧`;
  els.longTasks.textContent = report.metrics.longTasks;
  setStatus(`报告完成：${report.rating}${report.score === null ? '' : `，健康分 ${report.score}`}`, report.score === null ? 'normal' : report.score >= 70 ? 'good' : 'bad');

  els.attribution.innerHTML = report.attribution.length ? report.attribution.map((item) => `
    <article class="cause">
      <div><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.frames)} 帧 · ${escapeHtml(item.ratio)}%</span></div>
      <small>${escapeHtml(evidenceText(item))}</small>
      <p>${escapeHtml(item.advice)}</p>
    </article>`).join('') : '<p class="empty">未检测到明显掉帧。</p>';

  els.hotspots.innerHTML = report.hotspots.length ? report.hotspots.map((item) => `
    <tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.source)}</td><td>${escapeHtml(item.count)}</td><td>${escapeHtml(item.duration)}ms</td></tr>`).join('')
    : '<tr><td colspan="4">未捕获脚本热点。</td></tr>';

  const warnings = report.warnings || [];
  els.warnings.innerHTML = warnings.length
    ? [...new Set(warnings.map((item) => item.message))].map((message) => `<li>${escapeHtml(message)}</li>`).join('')
    : '<li>未发现异常。</li>';
  drawReportChart(report);
}

function drawReportChart(report) {
  chart.values = report.frames.slice(-120).map((frame) => ({
    fps: Math.round(1000 / frame.duration),
    duration: frame.duration,
    cause: frame.primary,
  }));
  drawChart();
}

function addWarning(code, message) {
  const li = document.createElement('li');
  li.dataset.code = code;
  li.textContent = message;
  if (![...els.warnings.children].some((item) => item.textContent === message)) els.warnings.append(li);
}

function applyScenario() {
  stopScenario();
  const type = els.scenario.value;
  const ctx = els.demo.getContext('2d');
  let frame = 0;
  const start = performance.now();

  function loop() {
    const now = performance.now();
    if (type === 'longTask' && frame % 4 === 0) {
      while (performance.now() - now < 130) {}
    }
    if (type === 'layout') {
      for (let i = 0; i < 220; i++) {
        const block = document.createElement('div');
        block.className = 'layout-block';
        $('#layoutBurst').append(block);
        block.style.width = `${20 + (block.offsetWidth % 20)}px`;
      }
      $('#layoutBurst').textContent = '';
    }
    if (type === 'canvas') {
      for (let i = 0; i < 900; i++) {
        ctx.fillStyle = `hsl(${frame * 3 + i}, 70%, 55%)`;
        ctx.fillRect((i * 17) % 600, (i * 11) % 240, 26, 26);
      }
    }
    if (type === 'workerTask') {
      state.stress.worker.postMessage(frame);
    }
    frame += 1;
    if (state.stress) state.stress.raf = requestAnimationFrame(loop);
  }

  const stress = { raf: 0, worker: null, start };
  if (type === 'workerTask') {
    stress.worker = new Worker('./src/stress-worker.js', { type: 'module' });
  }
  state.stress = stress;
  stress.raf = requestAnimationFrame(loop);
  setStatus('压测场景已启动，可同时开始采集。', 'warn');
}

function stopScenario() {
  if (!state.stress) return;
  cancelAnimationFrame(state.stress.raf);
  state.stress.worker?.terminate();
  state.stress = null;
}

els.start.addEventListener('click', start);
els.stop.addEventListener('click', stop);
els.json.addEventListener('click', () => state.report && exportJson(state.report));
els.csv.addEventListener('click', () => state.report && exportCsv(state.report));
els.html.addEventListener('click', () => state.report && exportHtml(state.report));
els.applyScenario.addEventListener('click', applyScenario);
els.clearScenario.addEventListener('click', () => {
  stopScenario();
  els.demo.getContext('2d').clearRect(0, 0, els.demo.width, els.demo.height);
});
window.addEventListener('error', (event) => addWarning('runtime', `运行异常：${event.message}`));

addWarning('ready', '监控器已加载；点击开始后进行采集。');
