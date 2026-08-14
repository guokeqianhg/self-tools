---
type: Reference
title: 性能优化外部资料索引
description: 按 FPS、掉帧、Jank、CPU、GPU、内存、I/O、温控等维度分类整理的官方技术文档与社区资源索引。
tags: [性能优化, 参考资料, FPS, Jank, 掉帧, CPU, GPU, 内存, I/O, 温控, Unity, Unreal, Profiling]
owner: 待指定
timestamp: "2026-07-23"
status: ready
---



## FPS、Frame Time 与 Jank 现象模式

### Android 官方文档

| 资源 | 核心内容 |
|---|---|
| Frame Rate [^1] | 帧率优化基础与目标 FPS 设定 |
| Slow Sessions [^2] | 慢会话诊断与 Jank 统计 |
| Slow Rendering [^3] | 渲染延迟导致的掉帧分析 |

### Unity 帧时间与 Stutter 诊断

- **性能分析最佳实践** [^27]：涵盖 FPS 监控与 Stutter 诊断方法论
- **减少 Shader/Pipeline 编译导致的 Stutter** [^45]（Godot 文档，原理跨引擎通用）

## CPU 优化与主线程阻塞

### Android ANR 诊断

- **诊断和修复超时** [^6]：主线程阻塞导致的无响应与掉帧问题

### Windows CPU Analysis

- **CPU 分析** [^24]：WPT 工具与线程级 Profiling

### Unity Draw Call 优化

- **Draw Call 绑定分析** [^50]：CPU 侧 Draw Call 开销诊断与优化

### Unreal Stat 命令

- **Stat 命令** [^42]：运行时性能统计与监控

### 主线程阻塞与调度

- **调度阻塞分析** [^46]：使用 Perfetto 追踪锁竞争与调度延迟

## GPU 渲染压力与优化

### Android GPU 渲染分析

- **GPU 渲染分析** [^16][^17]：使用 Android Studio 分析 GPU 渲染管线
- **估算 CPU 与 GPU 帧处理时间** [^18]：使用 Android GPU Inspector (AGI) 区分 CPU/GPU 瓶颈

### Metal 性能分析

- **Metal 应用性能分析** [^23]：iOS/macOS 图形性能剖析

### Unity Overdraw 与 Shader Stutter

- **图形性能优化** [^28]：涵盖 Overdraw 控制与 CPU/GPU 渲染负载降低
- **防止 Shader Stutter** [^36]：预编译与缓存策略消除管线卡顿

### Unreal Niagara 可扩展性

- **Niagara 可扩展性与最佳实践** [^43]：粒子系统 GPU 开销控制

### Vulkan Subpasses

- **Arm Vulkan Subpasses** [^47]：移动 GPU 带宽与能效优化

### GPU 优化案例

- **Netmarble 案例分析** [^19]：使用 Android Performance Analyzer 微调 GPU 性能

## 内存高水位与 GC 压力

### Android 堆转储与内存管理

| 资源 | 说明 |
|---|---|
| 捕获堆转储 [^7] | 内存快照与泄漏定位 |
| 应用内存分析 [^8] | 内存增长与掉帧的关联分析 |
| 内存管理概览 [^9] | 内存分配机制与泄漏防范 |

### iOS 内存优化

- **减少内存使用** [^20]：Xcode 内存优化指南

### Unity GC 模式与分配跟踪

- **垃圾收集器** [^29]：GC 模式与策略详解
- **增量式垃圾回收** [^30]：减少 GC 导致的 Jank
- **追踪 GC 分配** [^31]：监控内存分配热点

### Unreal 内存考量

- **常见内存与 CPU 性能考量** [^39]：内存布局与开销控制

### Windows 内存优化

- **内存与磁盘优化** [^26]：降低内存占用提升性能

## I/O 与资源加载

### Unity 纹理/网格加载与异步上传流水线

- **纹理与网格加载** [^34]：异步加载与内存管理
- **Profiler 追踪分析** [^35]：加载耗时诊断

### Unreal 异步资源加载

- **异步资产加载** [^40]：非阻塞式资源加载机制

### 通用 Streaming 原理

- **开放世界与资源流送** [^49]（Meta 文档）：场景流式加载与内存压力缓解

## 温控与热限频

### Android Thermal API 与功耗优化

- **Thermal API** [^10]：热状态监控与自适应降频
- **功耗效率优化** [^11]：平衡性能与发热

### 持续性能交付案例

- **GOALS 手持设备性能优化** [^48]：竞技游戏持续性能保障与热限频应对（GPUOpen）

## 配置与目标 FPS

### Android Frame Pacing 与 FPS 节流

- **优化刷新率切换** [^12]：动态刷新率适配
- **Frame Pacing 库** [^13]：平滑帧率控制与掉帧消除
- **FPS 节流** [^14]：游戏模式下的帧率限制策略

### Unreal/Unity 动态分辨率

- **Unreal 动态分辨率** [^41]：根据 GPU 负载动态调整渲染分辨率
- **Unity Adaptive Performance** [^33]：根据设备热状态与性能动态调整画质（三星/安卓适配）

## 平台特定分析工具

### Android Performance Tuner

- **Android Performance Tuner** [^15]：游戏内性能遥测与调优
- **Netmarble 案例分析** [^19]：实际调优案例参考

### Apple Instruments

| 工具 | 用途 |
|---|---|
| Instruments (Hangs) [^21] | 挂起与长时间阻塞分析 |
| Instruments (Hitches) [^22] | 卡顿与 Jank 分析 |
| Metal Performance Analysis [^23] | GPU 性能剖析 |

### Windows 分析工具

- **CPU Analysis** [^24]：WPT 深度分析
- **混合现实性能瓶颈** [^25]：PC 平台性能理解基础

### 引擎 Profiling 专项

**Unity:**
- **Profiler Markers** [^32]：自定义性能标记与代码级分析

**Unreal:**
- **性能分析与配置入门** [^38]
- **性能分析概览** [^44]（4.27 版本）：引擎内置 Profiling 工具链
- **Intel Unreal 优化基础** [^37]：Profiling 基础与 CPU/GPU 鉴别方法

## 社区视频资源（B站）

针对 1% Low 帧、内存频率、管线延迟等进阶主题的视频资源：

| 主题 | 资源 | 核心内容 |
|---|---|---|
| 硬件瓶颈平衡 | [^51] | CPU、GPU、RAM 与存储的瓶颈权衡 |
| 内存不足与 Low 帧 | [^52] | 双 SSD 协同缓解内存压力导致的 1% Low 帧下降 |
| 1% Low 帧与流畅度 | [^53] | 统计窗口内卡顿与流畅度关系 |
| 内存频率影响 | [^54] | 实测内存频率对游戏 FPS 的影响 |
| 管线级延迟分析 | [^55] | GPU Times、Frame Time、Present 延迟辨析 |
| 笔记本掉帧排查 | [^56] | 显卡利用率低与掉帧问题诊断 |
| CS2 帧数优化 | [^57] | CPU/GPU 占用不满时的优化策略 |

# Citations

[^1]: https://developer.android.com/games/optimize/framerate
[^2]: https://developer.android.com/games/optimize/vitals/slow-session
[^3]: https://developer.android.com/topic/performance/vitals/render
[^4]: https://developer.android.com/games/optimize/gameperformance
[^5]: https://developer.android.com/games/optimize/optimization-tips
[^6]: https://developer.android.com/topic/performance/anrs/diagnose-and-fix-anrs
[^7]: https://developer.android.com/studio/profile/capture-heap-dump
[^8]: https://developer.android.com/topic/performance/memory
[^9]: https://developer.android.com/topic/performance/memory-overview
[^10]: https://developer.android.com/games/optimize/adpf/thermal
[^11]: https://developer.android.com/games/optimize/power
[^12]: https://developer.android.com/games/optimize/display-refresh-rate-change
[^13]: https://developer.android.com/games/sdk/frame-pacing
[^14]: https://developer.android.com/games/optimize/adpf/gamemode/fps-throttling
[^15]: https://developer.android.com/games/sdk/performance-tuner
[^16]: https://developer.android.com/topic/performance/rendering/profile-gpu
[^17]: https://developer.android.com/topic/performance/rendering/inspect-gpu-rendering
[^18]: https://developer.android.com/agi/sys-trace/long
[^19]: https://developer.android.com/android-performance-analyzer/case-study/netmarble-perf-analyzer
[^20]: https://developer.apple.com/documentation/xcode/making-changes-to-reduce-memory-use
[^21]: https://developer.apple.com/documentation/xcode/understanding-hangs-in-your-app
[^22]: https://developer.apple.com/documentation/xcode/understanding-hitches-in-your-app
[^23]: https://developer.apple.com/documentation/xcode/analyzing-the-performance-of-your-metal-app/
[^24]: https://learn.microsoft.com/en-us/windows-hardware/test/wpt/cpu-analysis
[^25]: https://learn.microsoft.com/en-us/windows/mixed-reality/develop/advanced-concepts/understanding-performance-for-mixed-reality
[^26]: https://learn.microsoft.com/en-us/windows/apps/develop/performance/disk-memory
[^27]: https://unity.com/how-to/best-practices-for-profiling-game-performance
[^28]: https://docs.unity3d.com/6000.4/Documentation/Manual/OptimizingGraphicsPerformance.html
[^29]: https://docs.unity3d.com/6000.1/Documentation/Manual/performance-garbage-collector.html
[^30]: https://docs.unity3d.com/6000.0/Documentation/Manual/performance-incremental-garbage-collection.html
[^31]: https://docs.unity3d.com/6000.3/Documentation/Manual/performance-track-garbage-collection.html
[^32]: https://docs.unity3d.com/6000.0/Documentation/Manual/profiler-markers.html
[^33]: https://docs.unity3d.com/Packages/com.unity.adaptiveperformance%404.0/manual/user-guide.html
[^34]: https://docs.unity3d.com/6000.3/Documentation/Manual/LoadingTextureandMeshData.html
[^35]: https://docs.unity3d.com/6000.1/Documentation/Manual/performance-profiler-traces.html
[^36]: https://docs.unity3d.com/6000.3/Documentation/Manual/shader-prevent-stutter.html
[^37]: https://www.intel.com/content/www/us/en/developer/articles/technical/unreal-engine-optimization-profiling-fundamentals.html
[^38]: https://dev.epicgames.com/documentation/unreal-engine/introduction-to-performance-profiling-and-configuration-in-unreal-engine
[^39]: https://dev.epicgames.com/documentation/unreal-engine/common-memory-and-cpu-performance-considerations-in-unreal-engine
[^40]: https://dev.epicgames.com/documentation/unreal-engine/asynchronous-asset-loading-in-unreal-engine
[^41]: https://dev.epicgames.com/documentation/unreal-engine/dynamic-resolution-in-unreal-engine
[^42]: https://dev.epicgames.com/documentation/unreal-engine/stat-commands-in-unreal-engine
[^43]: https://dev.epicgames.com/documentation/unreal-engine/scalability-and-best-practices-for-niagara
[^44]: https://dev.epicgames.com/documentation/unreal-engine/performance-and-profiling-overview?application_version=4.27
[^45]: https://docs.godotengine.org/en/stable/tutorials/performance/pipeline_compilations.html
[^46]: https://perfetto.dev/docs/case-studies/scheduling-blockages
[^47]: https://developer.arm.com/community/arm-community-blogs/b/mobile-graphics-and-gaming/b/introducing-vulkan-subpasses-mobile-gpu-bandwidth-and-energy-efficiency
[^48]: https://gpuopen.com/learn/how-goals-delivers-performance-handheld-pcs-part1/
[^49]: https://developers.meta.com/horizon/documentation/unity/po-assetstreaming/
[^50]: https://thegamedev.guru/unity-cpu-performance/draw-call-bound/
[^51]: https://www.bilibili.com/video/BV13swseDEkr/
[^52]: https://www.bilibili.com/video/BV13qk8YEEca/
[^53]: https://www.bilibili.com/video/BV1tN411p75p/
[^54]: https://www.bilibili.com/video/BV1bfAfeEEDw/
[^55]: https://www.bilibili.com/video/BV1woYWzMESQ/
[^56]: https://www.bilibili.com/video/BV1C24y1F75M/
[^57]: https://www.bilibili.com/video/BV1Yu4y147HH/
