# 前端性能归因台

零依赖静态页面，用于监控 FPS、长任务、掉帧原因并导出报告。技术栈为 `PerformanceObserver`、Canvas 指标包装和 Web Worker。

## 启动

```bash
npm start
# 打开 http://127.0.0.1:5173
```

模块 Worker 需要通过 HTTP 服务访问，不建议直接双击 `index.html`。

## 采集内容

- FPS 与帧时长：用双采样点 `requestAnimationFrame` 计算真实帧间隔，后台帧单独标记。
- 长任务和动画帧：观察 `longtask` 与 `long-animation-frame`，提取脚本耗时、函数、来源 URL、强制布局耗时。
- 布局和资源：观察 `layout-shift`、`resource`、`paint`、`event`、`measure`、`navigation`。
- Canvas/WebGL：统计每帧绘制调用、像素覆盖、纹理上传、Buffer 更新、上下文丢失。
- 异常降级：不支持的 Observer 类型、Worker 异常、页面后台节流、超长帧间隔、WebGL 上下文丢失都会提示。

## 归因规则

| 原因 | 主要判据 | 建议 |
| --- | --- | --- |
| 主线程长任务 | 帧内出现超过 50ms 的 `longtask` | 拆分任务、迁移计算到 Worker、使用 `requestIdleCallback` |
| 动画回调耗时 | LoAF 或其中脚本超过帧预算 | 减少每帧 JS、状态更新和 DOM 写入 |
| 强制同步布局 | LoAF 脚本含较高 `forcedStyleAndLayoutDuration` | 批量读写样式，避免循环触发布局 |
| 布局变化 | 帧内 CLS 条目超过阈值 | 给图片/字体/异步内容预留空间 |
| Canvas 绘制过重 | 绘制调用、总调用数或绘制像素超阈值 | 脏矩形、离屏缓存、降低绘制指令 |
| Canvas 过度绘制 | 像素覆盖超过视口数倍 | 合并图层、跳过不可见区域 |
| WebGL 资源上传 | 每帧大纹理或大量 Buffer 更新 | 复用 Texture/Buffer，避免运行时反复创建 |
| 资源加载/解码 | 同一帧出现多个慢速资源 | 关键资源预加载，非关键资源延迟 |
| GPU/浏览器内部 | 帧严重超时但主线程无明显任务 | 用 Chrome Performance 面板进一步检查 GPU/合成 |
| 后台/系统节流 | 后台期间 RAF 被暂停或降频 | 切回前台恢复，不计为业务代码问题 |

证据不足时报告明确标记为“证据不足”，不会伪造成确定原因。

## 报告

采集结束后可导出：

- JSON：完整指标、归因、证据、热点、帧数据和异常列表，适合接入后端。
- 帧 CSV：每帧开始/结束时间、帧时长、FPS、主因和全部候选原因。
- HTML：离线可读报告，包含评分、指标、归因建议、脚本热点和异常提示。

## 性能控制

- 帧和性能条目在主线程只做轻量入队，按批次发给 Worker。
- 聚合、归因、评分和报告构建默认在 Worker 中执行；Worker 不可用时自动主线程降级并提示。
- Worker 内最多保留 3600 帧和每类 1500 条性能条目；导出最近 600 帧。
- 监控图表 Canvas 标记为 `__perfIgnore`，避免监控器统计自身绘图。
- 报告包含 `metrics.collectorOverhead`，记录包装点数、Canvas 调用量、RAF 次数和批处理次数。

## 验证

```bash
npm test
npm run check
```

自动化测试覆盖：长任务归因、强制布局、Canvas 过重、后台节流、CSV 导出、Canvas 包装和帧批处理。

## 手动验收

1. 点击“开始采集”，启动“主线程长任务”场景，停止后应识别“主线程长任务”。
2. 启动“强制布局/布局抖动”场景，应看到强制布局/动画回调归因和脚本热点。
3. 启动“Canvas 过度绘制”场景，应识别 Canvas 绘制或过度绘制。
4. 启动“Worker 计算负载”，主线程 FPS 应明显好于同量级长任务场景。
5. 切换浏览器标签页，应出现后台/系统节流提示；导出三种报告均应成功。
