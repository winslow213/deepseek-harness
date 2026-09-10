---
description: "A2UI 工具存储：模型如何把生成的页面保存为可在 harness 主目录下分发的 JSON 文件，以及部署如何重新导入已保存的工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-a2ui-store

[English](README.md) | 中文

## 概述

借助 `dsh-tool-a2ui-store`，模型用 `a2ui_surface` 生成的页面可以保存为独立文件并分享：`a2ui_export` 工具与 `ctx.a2uiStore` 能力把规范的页面定义——声明式 DSL、字段逻辑（`visibleWhen`/`validateWhen`/`compute`）以及 `actions`——按「每个工具一个 JSON 文档」持久化到 `<harness home>/a2ui-tools/`。每次写入都是原子替换，读取时畸形的文档会被跳过而不遮蔽其余文件。存储层就是分发边界：保存的文件可在部署之间复制、重新导入，而无需重新生成页面；保存的工具也可以作为自包含的承载令牌跨用户分享（`a2ui_share`/`a2ui_import`，或能力上的 `share`/`import`）。

本包还拥有两条页面关联的执行通道：`ctx.a2uiRun` 在会话工作区内通过组合的 shell 服务启动 `command` action，并把其输出记录为持久的 `a2ui/update` 流；`ctx.a2uiLive` 则把 `model` action 的后台 job 流式进入同一持久流（经 `a2ui_attach_output` 工具，模型用其刚启动的 job id 调用它）。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在需要让 agent 持久化其所生成页面的地方挂载此包。它在工具注册表上注册 `a2ui_export`、`a2ui_share`、`a2ui_import` 工具，并提供 `ctx.a2uiStore`。

### 最小配置

```yaml
- id: tool-a2ui-store
  name: '@deepseek-ai/dsh-tool-a2ui-store'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dir` | `<harness home>/a2ui-tools` | 存储目录；显式路径覆盖默认值 |

生成的 [配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-a2ui-store) 是权威来源。

### 保存循环

模型调用 `a2ui_export`，传入 `name` 与 `a2ui_surface` 渲染所用的同一 `page` 结构。页面经规范化（未知字段类型与节点角色被拒绝）后写入 `<dir>/<name>.json`；同名保存会替换文件。`ctx.a2uiStore` 向宿主消费者暴露 `list`/`save`/`remove` 以及 `share`/`import` 操作，保存记录携带页面与 ISO 格式的 `savedAt` 时间戳。`share(name)` 把已保存工具编码为 `a2ui-share:` 令牌；`import(token)` 重新规范化令牌中的页面并持久化，替换任何同名工具。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 —— 点击展开</summary>

存储层是轻量、依赖极少的文件系统层。`store.ts` 解析目录（显式覆盖优先，否则 `$DSH_HOME/a2ui-tools`），用 `writeFileAtomic`（临时兄弟文件 + rename，文件 `0o600`／目录 `0o700`）写入每个工具，使并发读者始终看到完整文档，并按名称排序的 `.json` 词干列举。工具名必须是单一安全文件词干（无分隔符、非 `.`/`..`、至多 64 字符）。`share.ts` 把工具编码为 `a2ui-share:<base64url>` 令牌，并在解码时做完整重新校验。`index.ts` 在 `ctx` 上提供能力并注册工具。`run.ts` 在会话工作区内通过 shell 服务启动 `command` action，并把其输出追加为 `a2ui/update` 事件；`live.ts` 通过独立 jobs reader 把 `model` action 的后台 job 输出流式进入同一事件流。两者都复用 `dsh-tool-a2ui-surface` 的 `canonicalizeA2uiPage`，使保存与渲染的页面逐字节一致。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`ctx.a2uiStore`/`ctx.a2uiRun`/`ctx.a2uiLive` 能力、`a2ui_export`/`a2ui_share`/`a2ui_import` + `a2ui_attach_output` 工具注册 |
| [`src/store.ts`](src/store.ts) | 文件系统持久化：带原子写的 resolve/save/list/remove |
| [`src/share.ts`](src/share.ts) | 自包含分享令牌：编码/解码，导入时规范化 |
| [`src/run.ts`](src/run.ts) | `command` action 运行器：shell 引用、工作区 workdir、`a2ui/update` 发出 |
| [`src/live.ts`](src/live.ts) | 经 `ctx.jobs` 的 `model` action 实时结果流式 |
| [`src/types.ts`](src/types.ts) | 客户端安全的 `A2uiToolRecord`、`A2uiUpdateData` 与名称安全规则 |

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到的内容

模型看到四个工具。`a2ui_export` 携带其静态描述以及生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-a2ui-store)中记录的确切 JSON schema；描述告诉它把所创作的页面保存为本地工具库中的可复用工具文件，为已保存文件提供一个简短稳定的 `name`，以及一个与 `a2ui_surface` 的 page 参数形态相同的 `page`。`a2ui_share` 接收已保存工具的 `name` 并返回其 `a2ui-share:` 令牌；`a2ui_import` 接收 `token` 并保存解码后的页面。`a2ui_attach_output` 接收 `surfaceId` 与 `jobId`，并告诉它在 A2UI action 中启动后台 job 后调用它，使页面的实时结果面板跟随该 job 的输出。

#### Token 影响

每次工具对 agent 可见的请求都承担固定的描述与 schema 开销。`name` 字符串与 `page` 对象比字段丰富的页面工具更轻量，因此该定义比 `a2ui_surface` 的 schema 更便宜；`a2ui_share`/`a2ui_import`/`a2ui_attach_output` 各自只增加一到两个短字符串。

#### KV Cache 影响

只要注册的定义与其可见性不变，前缀即稳定；插件生命周期或受限的工具范围可能从首个变化的 schema token 起使复用失效。

### 工具调用与结果

#### 模型看到的内容

工具调用把所创作的页面 JSON 保留在历史中。成功时精确渲染 `Saved A2UI tool "<name>" to the local tool store.`；没有所属 agent 会话的调用以 `a2ui_export requires an owning agent session` 失败；非法页面以指明违规的规范化错误失败。`a2ui_share` 渲染令牌文本，`a2ui_import` 渲染 `Imported A2UI tool "<name>" from a share token.` 或以令牌校验错误失败。

#### Token 影响

所创作的页面参数会保留在历史中直到压缩，并随模型所写页面规模变化；渲染结果是短固定文本加上已保存的名称。

#### KV Cache 影响

仅追加；调用与结果跟随可复用的请求前缀，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **存储仅限宿主侧** —— 它在 harness 主目录下持久化文件；把列表暴露给浏览器侧边栏并在客户端重新渲染已保存工具，需要 Remote 命名空间与客户端面板，这不在本包范围内。
- **分享令牌是承载值** —— 令牌携带完整页面，没有吊销或过期；任何持有它的人都能导入，且导入会替换同名工具。
- **无实时监听** —— 列表按需读取；其他进程新增的文件在下一次 `list()` 时出现，而非推送。
- **每个工具一个文档** —— 工具是单个 JSON 文件；存储层不做版本或 diff。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

无。

</details>
