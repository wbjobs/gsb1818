export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const index = clamp(Math.ceil((p / 100) * sortedValues.length) - 1, 0, sortedValues.length - 1);
  return sortedValues[index];
}

export function summarize(values) {
  if (!values.length) {
    return { min: null, max: null, mean: null, p50: null, p95: null, p99: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    mean: round(sum / sorted.length),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
  };
}

export function shortName(url = '') {
  if (!url) return 'inline';
  return String(url).split('/').pop()?.split('?')[0] || url;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function download(filename, content, type = 'application/json') {
  const blob = new Blob([content], type.startsWith('text/') ? { type: `${type};charset=utf-8` } : { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const ADVICE = {
  background_throttle: '页面位于后台或标签页被系统节流；切回前台后恢复，无需修改页面。',
  long_task: '拆分主线程长任务：推迟非关键逻辑、使用 requestIdleCallback，或将计算迁移到 Web Worker。',
  animation_frame: '动画帧回调过重；减少每帧 React/Vue 更新、DOM 写入和复杂 JS 计算。',
  script: '精简脚本执行：代码分割、延迟第三方脚本、缓存解析结果，并检查热点函数调用次数。',
  forced_layout: '避免强制同步布局：批量读取几何属性后再统一写入，不要在循环中交替读写 DOM 样式。',
  layout_shift: '减少布局抖动：为图片/广告/字体预留尺寸，避免在动画中改变宽高和文档流。',
  canvas: '降低 Canvas 每帧成本：减少绘制指令与离屏重绘，启用脏矩形、离屏缓存或 OffscreenCanvas。',
  canvas_overdraw: '减少 Canvas 过度绘制：合并图层、跳过不可见区域、降低阴影/滤镜和全帧 clear/draw 次数。',
  webgl_upload: '减少 WebGL 上传：复用 Buffer/Texture，避免每帧创建资源或重复 texImage2D/drawElements。',
  resource: '资源阻塞帧渲染：预加载关键资源、压缩缓存图片/字体，并延后非关键请求。',
  paint: '浏览器绘制/合成压力较高：减少大面积重绘、动画化 transform/opacity，并降低图层复杂度。',
  gc: '疑似垃圾回收暂停：复用数组/对象、避免每帧创建闭包和大字符串，使用对象池。',
  renderer_unknown: '主线程没有明显长任务，可能是 GPU/合成或浏览器内部阻塞；建议结合 Chrome Performance 面板验证。',
  unknown: '缺少足够时序证据；建议延长采集时间并结合浏览器 Performance 面板复核。',
};

export const CAUSE_LABEL = {
  background_throttle: '后台/系统节流',
  long_task: '主线程长任务',
  animation_frame: '动画回调耗时',
  script: '脚本执行',
  forced_layout: '强制同步布局',
  layout_shift: '布局变化',
  canvas: 'Canvas 绘制过重',
  canvas_overdraw: 'Canvas 过度绘制',
  webgl_upload: 'WebGL 资源上传',
  resource: '资源加载/解码',
  paint: '绘制/合成压力',
  gc: '疑似 GC 暂停',
  renderer_unknown: 'GPU/浏览器内部',
  unknown: '证据不足',
};
