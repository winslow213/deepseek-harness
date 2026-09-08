# Agent Note: A2UI 统一 Function 运行时与受控脚本

Status: implemented

[English](2026-09-08-a2ui-function-runtime-controlled-scripts.md) | 中文

## Problem

A2UI 页面过去有三种互斥的按钮语义——`local`（显示表达式文本）、`model`（转给 agent）、`command`（在宿主跑 shell 命令并写入 console）——直接硬编码在渲染器的 `if/else` 里。页面缺少统一的「可执行函数」概念，缺少一个把所有执行结果折叠进页面状态的唯一位置，也无法以受控方式运行小的数据抓取/重塑程序（`script`）：模型只能声明表达式、点名工具或命令，不能编写组合步骤的程序。每新增一种执行类型都要分别改动渲染器、弹窗宿主与 wire 协议。

## Decision

A2UI 变成可执行组件运行时，分三层正交设计。

- **统一调用路由**（`a2ui-runtime.ts`，零 cordis）。`invokeAction(action, values, surfaceId, evaluate, localDone)` 把一次点击解析为恰好一种调用：在浏览器计算的 `expr` 结果、运行宿主 shell 命令的 `command` 消息、运行宿主程序的 `script` 消息、或发给 agent 的 `model` 消息。渲染器不再按执行模式分支；每种后端都是这个纯函数里的一个 case。
- **单一弹窗状态机**（`reducePopupState`）。每个 opener 回复——ack、run started/chunk/done/failed、stop、script 结果/失败——都折叠进唯一的 `A2uiPopupState`（busy、命令 console 的 `A2uiRunState`、local 结果、script 结果/错误）。独立弹窗宿主只是这个投影之上的薄 `useReducer`；组件里的散乱 `useState` 消失了。
- **受控 `script` 执行**（`tool-a2ui-store/script.ts`）。新增 `execution: "script"` action，携带 async `program` 主体与 `binds` 授权列表。程序在组合出的 code runtime（`ctx.codeRuntime`，web profile 中的 worker-thread 后端）上运行——绝不在浏览器、绝不在宿主进程——并受运行时墙钟/输出上限与 abort 语义约束。程序只能调用被授权的 `a2ui.*` 成员，每个成员都是现有能力之后的宿主助手：
  - `fetch` —— 通过 harness web 服务（`ctx.web.fetch`，base bundle 的 http provider）发起一次 `http(s)://` 请求；任何调用前先校验 URL scheme，JSON 摘要（url、status、content 类型/文本、truncated）穿过 code-runtime 边界。
  - `text` —— 确定性纯重塑助手（转大写）。
  完成值与日志穿过运行时 lossless-JSON 边界成为 action 结果，在弹窗中显示。

wire 协议（`a2ui-wire.ts`）与 launcher bridge 承载新类型；Remote 命名空间 `a2uiRun` 增加 `runScript`；`ctx.a2uiRunScript` 懒解析 code runtime 与 web 服务，使 store 插件在缺任一的组合中也能挂载。

## Alternatives considered

**在浏览器里跑脚本。** 否决：数据抓取脚本所需的跨源 fetch 浏览器做不了，而且仓库「浏览器绝不执行任意模型生成代码」的不变式正是受限表达式语法存在的原因。脚本是*程序数据*，在受控 code runtime 上执行，绝不是页面会求值的源码。

**向脚本暴露每个宿主能力。** 否决：脚本只能获得它声明的 `binds`，每个成员映射到某个被拥有能力后的一个助手，因此攻击面是声明的授权列表，而非整个上下文。未知授权在 canonicalize 即拒。

**给 `script` 单独建 wire/流式机制。** 否决：脚本是单次请求/响应（一个完成值），不像 `command` 是长流，因此它复用普通 Remote 往返与 ack 生命周期，而非 command-run 的分块通道。

## Consequences

新执行类型现在是 `invokeAction` 里的一个 case、wire 协议里的一对消息、`reducePopupState` 里的一个状态转移、加一个宿主后端——每块独立单测。受影响全套测试通过（152）。脚本的 `fetch` 继承 web 能力的 provider 选择与策略（为模型的 `web_fetch` 工具配置了什么，A2UI 页面就能触达什么）；未挂载 web 服务的部署会在运行开始时以清晰消息拒绝被授权的 `fetch`，而不是静默降级。受控 code runtime 依赖意味着 profile 必须先挂载 `ctx.codeRuntime`（web-app 的 worker-thread provider），script action 才能运行；`ctx.a2uiRunScript` 仍懒解析，使 store 插件在别处也能加载。Binding 调用是 async 的，程序里必须 `await`——未 await 的调用会把 Promise 留在完成值里，run 会撞上 lossless-JSON 边界（worker 会点名该失败）。
