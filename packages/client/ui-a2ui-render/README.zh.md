---
description: "模型生成 A2UI 页面的零 cordis React 渲染器：表单与画布面板、独立弹窗挂载点，以及弹窗线上协议，由 Web 前端专用的 /a2ui.html 窗口消费。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-a2ui-render

[English](README.md) | 中文

## 概述

`dsh-client-ui-a2ui-render` 是绘制模型生成 A2UI 页面的零 cordis React 库。它拥有 `form` 与 `canvas` 面板、字段逻辑表达式求值器、独立弹窗挂载点（`renderA2uiPopup`）以及弹窗线上协议。它由 Web 前端专用的 `/a2ui.html` 窗口消费：`ui-a2ui` 插件不再内嵌渲染页面，而是显示一个启动卡片，其按钮打开这个弹窗。让渲染器不依赖客户端 Context 合并，正是静态装配能够在不同入会话外壳的情况下打包它的原因。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

引入 `renderA2uiPopup` 并把一个页面挂载到弹窗窗口的 DOM 节点：

```ts
import { renderA2uiPopup } from '@deepseek-ai/dsh-client-ui-a2ui-render'

renderA2uiPopup(root, { surfaceId, page })
```

挂载点从 `localStorage`（`dsh.locale`）读取当前语言，并通过 `window.opener.postMessage` 把提交与 `model` 模式动作回传给打开者。`local` 动作完全在浏览器内解析，不发送任何消息。

### 弹窗线上协议

- 打开者 → 弹窗：`{ type: 'a2ui/init', surfaceId, page }`、`{ type: 'a2ui/ack' }`。
- 弹窗 → 打开者：`{ type: 'a2ui/ready' }`、`{ type: 'a2ui/submit', surfaceId, payload }`、`{ type: 'a2ui/action', surfaceId, action, values }`。

打开者（`ui-a2ui` 的启动卡片）把提交与动作序列化为模型的 `a2uiSubmit` / `a2uiAction` 消息。

-----

<a id="understand-the-implementation"></a>
## 理解实现

面板接受一个与通道无关的 props 形状（`page`、`surfaceId`、`t`、`busy`、`onSubmit`、`onAction`），而不是聊天槽位 props。`A2uiFormPanel` 持有字段值，并通过受限、无 `eval` 的表达式求值器计算 `visibleWhen`/`validateWhen`/`compute`；`A2uiCanvasPanel` 持有 React Flow 节点图。共享的 `A2uiChrome` 为两者绘制标题、描述、说明、错误、本地结果、动作按钮与提交控件。

-----

<a id="model-experience"></a>
## 模型体验

None, as 该包是一个零 cordis 的 A2UI 渲染器库，它绘制页面并把收集到的值回传给打开者，由打开者负责模型序列化。

#### KV Cache effect

None; 该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 该渲染器是组件库而非插件；挂载与语言注册仍归 `ui-a2ui`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
