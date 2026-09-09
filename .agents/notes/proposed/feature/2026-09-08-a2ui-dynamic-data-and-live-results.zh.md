# Agent Note: A2UI 动态数据源与实时结果通道

Status: proposed

[English](2026-09-08-a2ui-dynamic-data-and-live-results.md) | 中文

## Problem

A2UI 页面是一次性声明，浏览器只求值一遍。字段逻辑（`visibleWhen`/`validateWhen`/`compute`）只能响应同页兄弟字段；`model` 模式的 action 把收集值交给模型，而工具结果从不回到窗口。团队要做一个「日志抓取」这类工具，需要页面目前无法表达的三种能力：

- **动态数据** —— 选项或派生值来自真实数据源（`hdc list targets` 的设备列表、目录清单、指标读数），而不是生成时写死在页面里。
- **动态执行** —— 页面打开后自定义工具逻辑仍能运行（刷新数据源、监视命令、停止正在进行的抓取），而不是只在字段变化时做声明式计算。
- **实时结果** —— 长命令运行期间窗口显示日志吞吐，结束后保留完整转录。

设计受两条约束约束。弹窗是最小文档、没有宿主连接：目前只交换一次性的 `ready`/`init`/`ack` 握手（[弹窗窗口化](../../implemented/feature/2026-09-08-a2ui-popup-window-and-render-split.zh.md)）。此外仓库要求任何进入模型请求的内容都必须能从会话日志重建（[模型可见 ⟺ 已记录](../../implemented/architecture/2026-08-10-session-log-version-mechanism.zh.md)），因此凡是可能喂给模型 payload 的数据都必须落成持久会话事件，绝不能走旁路通道。

## Proposal

在现有 DSL（[表单](../../implemented/feature/2026-08-20-a2ui-model-authored-form-pages.zh.md)、[字段逻辑与 actions](../../implemented/feature/2026-09-07-a2ui-field-logic-and-actions.zh.md)）之上做三个彼此可独立落地的增强，均保持可重放与弹窗的轻量性。

**1. 数据源绑定。** 已实现——见 [A2UI 动态数据源提供者 seam](../../implemented/feature/2026-09-09-a2ui-data-source-provider.zh.md)。字段（先做 `select`，后续做由数据源派生的只读文本）可用 `source` 声明来取代静态 `options`。已随附实现通过宿主侧**数据提供者**（基于 `bash` 的提供者运行一条经白名单放行的只读命令）解析 `source`，选项经由 Remote 往返返回，而非本提案所述持久 `a2ui/data` 事件；该事件已暂缓，因为选项列表对模型不可见。

**2. 实时结果通道。** 长任务是一条 `jobs` 流。方案新增一个会话事件 `a2ui/update`，其信封载荷为 `{ surfaceId, phase: 'started' | 'delta' | 'finished' | 'aborted', seq, delta?, totalBytes? }`，其中 `delta` 是自上一事件以来的有界增量文本（字节偏移 `seq` 使重放幂等），`totalBytes` 与时间戳让客户端推导吞吐。当与页面关联的 `model` action 运行时，所属 agent 的工具执行器发出该事件，复用后台 `bash` 已产生的既有 `jobs` 流 delta（`readOutput` 返回自上次读取以来的增量）。本就跟踪弹窗的 launcher 订阅其 `surfaceId` 对应的发出事件，并把每个事件作为 `a2ui/update` postMessage 转发。事件带 `ignorable: true`，因为早于它的构建仍必须能重放周围日志（[版本机制](../../implemented/architecture/2026-08-10-session-log-version-mechanism.zh.md)）。

**3. 脚本化 local actions。** 超出单个表达式的自定义逻辑，变成 `local` action 上的声明式**步骤列表**：`set`（给某字段赋值）、`append`（拼接到目标）、`refresh`（重新发起某数据源）、`stop`（终止关联的 job）。每个步骤是一条受限表达式或一个数据源名——与浏览器已经信任的求值器同一语法，由现有表单/画布宿主按序执行。任意 JavaScript 明确排除在范围外：页面绝不能运行模型生成的代码，只能执行渲染器能记录、能推理的声明操作。

**呈现。** 当页面或 action 携带实时结果时，弹窗渲染一个控制台/日志面板：`delta` 事件到来时逐行追加，速率标签按 `totalBytes` 与经过时间显示，`stop` 映射到关联 job 的终止。该面板是对持久 `a2ui/update` 事件的可见 UI 投影；它绝不编造日志里不存在的内容。

## Alternatives considered

- **让页面运行任意 JavaScript。** 否决：受限语法正是为了让浏览器绝不执行任意模型文本（[表达式语法](../../implemented/feature/2026-09-07-a2ui-field-logic-and-actions.zh.md)）；命令式步骤词汇让每个副作用保持声明式、已记录、能力受控。
- **用旁路 socket/WebSocket 推送结果。** 否决：「模型可见 ⟺ 已记录」规则与重放契约使非日志的旁路通道成为可重建性漏洞。窗口显示的每个载荷都走会话事件并由 launcher 转发。
- **让弹窗自行轮询宿主。** 否决：弹窗按设计不拥有宿主连接（[弹窗窗口化](../../implemented/feature/2026-09-08-a2ui-popup-window-and-render-split.zh.md)）；打开方是它唯一的通道，因此所有更新都走 打开方 → launcher → 弹窗。
- **改用聊天里的 jobs UI 而不是投影进弹窗。** 推迟：job 列表/状态已在会话内存在，但工具的日志视图属于工具自己的窗口；聊天界面不承载按 surface 划分的实时面板。

## Acceptance criteria

- `select` 上的 `source` 经过一次 `a2ui/data-request` 往返即得到实时选项，无需模型手写选项列表；重放该会话会重渲染出相同选项。
- 长 `model` action 产生带单调递增 `seq` 的有界 `a2ui/update` delta；弹窗增量渲染它们，并按 `totalBytes` 与事件时间戳推导字节速率；`stop` 终止关联 job，最终 `aborted`/`finished` 事件让面板归于平静。
- `local` action 步骤列表按序执行且只执行声明的步骤；未知步骤或数据源在 schema 校验处失败，绝不在页面进行到一半时于运行时失败。
- 新日志能在新构建上重放、旧构建也能处理新日志：新事件带 `ignorable: true`，不含 `source`/`update` 字段的既有页面渲染不变。
- 两套 SDK 的 loop 投影与会话日志版本 gate 在同一个改动里随新事件类型一起更新。

## Risks

- **事件量。** 日志风暴可能淹没日志。每个 delta 都有大小上限，提供者受白名单与缓存约束，溢出落到既有 spill-path 机制而不是让转录无限膨胀。
- **吞吐精度。** 速率由客户端按事件时间戳推导；突发的宿主或被节流的 postMessage 会让它成为估计值。标注为近似值，而非承诺逐字节精确的遥测。
- **SDK 与格式涟漪。** 新的 `SessionEventMap` 成员及其期望输出必须与事件一起落入 TypeScript 与 Python SDK（[两套 SDK 投影 loop](../../implemented/architecture/2026-08-10-session-log-version-mechanism.zh.md)）；结构性格式变更还要复查是否必须提升 `SESSION_FORMAT_VERSION`。
- **滑向终端的范围蔓延。** 该面板是有界日志视图，不是终端模拟器；交互式/proc 类 shell 留在 A2UI surface 之外。
