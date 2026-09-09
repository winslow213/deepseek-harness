---
description: "A2UI 动态数据源能力：部署方如何组合一个 provider，把稳定的 source 名解析为 select 字段的选项，以及浏览器所触达的 Remote 命名空间。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-a2ui-data

[English](README.md) | 中文

## 概述

`dsh-tool-a2ui-data` 是 A2UI `select` 字段选项来自实时来源（而非模型手写的列表）这一能力背后的 capability seam。字段声明一个稳定的 `source` 名；浏览器 launcher 经 `ctx.remote.a2uiData` 命名空间询问主机，组合的 provider（`ctx.a2uiData`）解析该名字，选项返回给弹窗。模型只书写 source 名，从不书写数据——source 是部署方拥有、经过校验的白名单，因此页面无法经数据源通道触达任意主机执行。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包是库而非插件：它声明 `ctx.a2uiData` provider 契约与 `A2uiDataController` Remote 服务，但组合还必须挂载一个提供 `ctx.a2uiData` 的 provider。随发行版提供的 provider 是 [`dsh-tool-a2ui-data-bash`](../tool-a2ui-data-bash/README.zh.md)；部署方在 surface 工具旁组合一个 provider。

### provider 契约

provider 实现两个方法：

| 成员 | 含义 |
|---|---|
| `has(source)` | provider 是否注册了该 source 名；其余一律在运行任何命令前拒绝。 |
| `resolve(source, args)` | 把 source 解析为 `{ items: [{ label, value }] }`；`args` 是 provider 可引用的已收集字段值。 |

Remote 命名空间（`ctx.remote.a2uiData.resolve`）以 `a2ui-data/unknown-source` 拒绝未知 source；浏览器 launcher 把成功解析作为 `a2ui/data`、把失败作为 `a2ui/data-failed` 转发给弹窗。

### `./types` 子路径

wire 请求/响应与解析结果契约以浏览器安全的 `./types` 子路径发布（仅类型），因此浏览器半边读取的正是主机发出的那些声明。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[`src/data.ts`](src/data.ts) 声明每个消费者从 `ctx.a2uiData` 读取的 `A2uiDataProvider` 接口。[`src/remote.ts`](src/remote.ts) 声明 `a2uiData` Remote 命名空间宿主（`A2uiDataController`），其唯一的 `resolve` 方法按 provider 白名单校验 source 并返回其选项。[`src/types.ts`](src/types.ts) 承载浏览器安全的 wire 类型。本包没有自己的 `apply`：provider 插件提供 `ctx.a2uiData` 并在其旁挂载 `A2uiDataController`，正如 `dsh-tool-a2ui-store` 挂载其控制器那样。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 再导出 provider 契约、wire 类型与 Remote 控制器 |
| [`src/data.ts`](src/data.ts) | `A2uiDataProvider` capability 契约 |
| [`src/remote.ts`](src/remote.ts) | `a2uiData` Remote 命名空间宿主（`resolve`） |
| [`src/types.ts`](src/types.ts) | 客户端安全的 wire 请求/响应与解析结果契约 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-tool-a2ui-data-bash](../tool-a2ui-data-bash/README.zh.md)——随发行版提供的 bash-backed provider。
- [dsh-tool-a2ui-surface](../tool-a2ui-surface/README.zh.md)——页面声明 `source` 字段所依赖的面向模型工具。
- [dsh-client-ui-a2ui](../../client/ui-a2ui/README.zh.md)——触达 `ctx.remote.a2uiData` 的浏览器 launcher。

-----

<a id="model-experience"></a>
## 模型体验

无。本包是主机 capability 与 Remote 命名空间，没有面向模型的工具；模型只在 `a2ui_surface` 的 schema 上看到 `source` 字段描述。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **provider 由组合负责**——本包声明 seam 但不随附实现；未组合任何 provider 的部署没有可解析的 source，浏览器 launcher 会把每个这样的字段报告为失败。
- **解析结果尚未持久化**——选项经 Remote 返回值返回，不记录为 session 事件，因此页面重新请求会再次运行 provider 而不是回放已记录的结果；持久 `a2ui/data` 事件被延期。
- **首次挂载不使用 source 参数**——弹窗在页面打开时以空参数请求 source；依赖另一字段取值的 source 需要后续的刷新机制。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

动态数据源设计（`source` 字段、provider seam 与被延期的持久 `a2ui/data` 事件）记录在[A2UI 动态数据源提案](../../../.agents/notes/proposed/feature/2026-09-08-a2ui-dynamic-data-and-live-results.zh.md)。

</details>

**运行时不变式：** 不发布伴生包。本包声明一个 provider 契约与一个 Remote 命名空间；控制器的 HMR 安全与 source 校验行为由其单元测试固定，没有可能分叉的独立运行时状态。
