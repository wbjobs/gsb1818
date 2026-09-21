# 前端性能监控台

基于 **PerformanceObserver + Canvas + Web Worker** 的页面性能监控工具：
实时采集 FPS / 帧耗时 / 长任务 / 异常，在 Worker 中完成**掉帧归因**与**优化建议**生成，
支持一键导出 **HTML + JSON 报告**。

## 运行

Web Worker 要求通过 HTTP 访问（`file://` 下部分浏览器会拦截）：

```bash
cd A && python3 -m http.server 8080
# 打开 http://localhost:8080
```

## 架构

| 模块 | 线程 | 职责 |
|---|---|---|
| `js/monitor.js` | 主线程 | rAF 帧采样、PerformanceObserver（longtask/paint/measure/resource/first-input）、异常捕获、内存采样，500ms 批量上报 |
| `js/analyzer-worker.js` | Worker | 掉帧判定（帧耗时 > 2×预算）、时间重叠归因、规则引擎生成建议、会话级报告数据 |
| `js/main.js` | 主线程 | 桥接与 UI：Canvas 实时帧耗时图、指标面板、演示负载、导出触发 |
| `js/report.js` | 主线程 | 报告导出（自包含 HTML + 原始 JSON） |

## 掉帧归因规则（按优先级）

1. **long-task**：掉帧窗口与长任务（>50ms）重叠，含 attribution 来源定位
2. **layout-thrash / script-measure**：与 `performance.measure` 打点重叠
3. **resource-loading**：与慢资源（>100ms）加载/解码重叠
4. **gc-pressure**：掉帧前 2s 内堆内存上涨 >8MB（Chromium）
5. **unknown**：提示排查合成器/GPU 负载

刷新率自适应：用最近 120 帧间隔中位数估算（兼容 60/120/144Hz 屏）。

## 验收对照

- **准确识别掉帧原因**：页面提供 5 个演示负载按钮（长任务/布局抖动/GC/大图/异常）验证归因
- **建议可操作**：每条归因映射到具体优化手段（分片、Worker、批量读写、对象池、preload 等），按优先级排序
- **报告可导出**：HTML（可视化）+ JSON（原始数据），含摘要、归因统计、掉帧明细、建议、异常列表
- **性能可接受**：分析全部在 Worker；主线程仅批量 postMessage；帧缓冲与事件列表均有环形上限
- **异常有提示**：采集器异常、Worker 异常、运行时异常（error/unhandledrejection）均通过顶部 toast 与异常面板提示
