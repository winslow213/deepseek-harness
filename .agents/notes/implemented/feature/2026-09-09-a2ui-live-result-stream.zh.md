# Agent Note: A2UI 实时结果流作为持久、可重放事件

状态：已实现

[English](2026-09-09-a2ui-live-result-stream.md) | 中文

## 问题

启动长任务的 A2UI 页面没有可重放的实时视图。`command` action 本已把输出流式显示到弹窗，但走的是 Remote 轮询旁路通道，从不进入会话日志，因此页面无法从重放重新渲染其控制台。触发后台 job 的 `model` action 则完全没有任何通道：job 的输出由模型通过 `job_output` 读取，而后者拥有该 job 的单一消费游标，第二个消费者（页面的实时结果面板）会偷走模型的增量。[动态数据源与实时结果提案](../../proposed/feature/2026-09-08-a2ui-dynamic-data-and-live-results.zh.md)把此列为其第二个能力：把 `jobs` 流投影为有界、幂等的 `a2ui/update` 事件流。

## 决策

与页面关联的运行——`command` action 或 `model` action 的后台 job——发出持久 `a2ui/update` 流，且后台 job 获得一个独立 reader，使第二个消费者永不消费模型的游标。

- **事件。** `SessionEventMap` 增加 `a2ui/update`，载荷为 `{ surfaceId, phase: 'started' | 'delta' | 'finished' | 'aborted', seq, delta?, totalBytes? }`。它仅记录（模型从不读取），因此不带 surface 元数据，是普通的事件词汇新增——无需提升 `SESSION_FORMAT_VERSION`，只需更新 persistence-catalog 已知类型集。每个 `delta` 只携带自上一事件以来的文本；`totalBytes` 是累计值，用于吞吐标签。
- **Command actions。** `ctx.a2uiRun` 在会话挂载的工作区（`session.header.cwd` 作为 workdir）运行 `command` action，每次消费读追加一条 `a2ui/update`，并在终止时追加 settle。`a2uiRun.start` Remote 请求增加 `sessionId`+`surfaceId`，控制器解析所属 agent 构建 session 适配器，对离线 agent 拒绝。
- **独立 reader。** `ShellProcess.createOutputReader()` 返回带独立游标的非消费 reader；bash-local 与 pwsh-local 基于各自的 per-reader 偏移实现。`JobHooks.createOutputReader?()` 与 `JobRegistry.openOutputReader(id, caller)` 将其暴露给第二个消费者，对不提供 reader 的 final-output 生产者抛错。
- **Model actions。** 模型通过新的 `a2ui_attach_output(surfaceId, jobId)` 工具显式把 job 绑定到 surface。`ctx.a2uiLive` 随后打开独立 reader、轮询它，并发出同样的 `a2ui/update` 流直到 job 终止（`killed` → `aborted`，否则 `finished`）。模型的 `job_output` 读取保留自己的游标。

## 备选方案

**只经 Remote 旁路通道推送实时视图。** 否决：`command` action 已这样做，但它无法从会话日志重建——仓库的「模型可见 ⟺ 已记录」规则与重放契约使非日志旁路成为可重建性漏洞。持久事件才是让重放重新渲染同一控制台的原因。

**从模型的 `job_output` 读取派生实时视图。** 否决：`job_output` 拥有 job 的单一消费游标；「旁听」那些读取的面板在模型不读时什么也看不到，而且面板的每次读取都会从模型偷走一段增量。

**自动 surface 关联。** 否决而采用显式绑定：「活跃 surface」启发式（启动 job 的那个 model action 的 turn）需要宿主侧关联状态机，以及 jobs seam 目前不暴露的 job 启动信号。显式 `a2ui_attach_output` 是模型本已掌握信息的一次工具调用，它让绑定无歧义且可重放。

## 后果

`command` action 与 `model` action 的后台 job 都能把持久、可重放的实时流投影进弹窗。`model` action 路径依赖模型在启动 job 后调用 `a2ui_attach_output`；若遗漏该调用，页面不显示实时面板（job 仍会运行，并可通过 `job_output` 读取）。独立 reader 打开时从字节偏移 0 读取，因此 attach 前产生的输出会在第一个 delta 中送达。流在 job 达到终止状态时 settle 并清除轮询定时器；teardown 移除的 job 或 reader 失败会 settle 为 `aborted`。
