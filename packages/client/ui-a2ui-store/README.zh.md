---
description: "dsh Web 客户端中用于已保存 A2UI 工具的侧边栏面板：如何列出由 a2ui_export 导出到本地工具库的页面，以及如何通过 a2uiStore Remote 将其中一个重新打开到当前会话。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-a2ui-store

[English](README.md) | 中文

## 概述

`dsh-client-ui-a2ui-store` 是一个浏览器插件，为已保存的 A2UI 工具增加一个侧边栏底部入口。点击该入口会打开一个弹层，列出此前由 `a2ui_export` 工具保存到 Harness 主目录 `a2ui-tools` 目录下的每一个页面；点击某个工具会将其页面重新打开到当前会话，垃圾桶按钮则删除已保存的文件。列表及每个操作都通过 `a2uiStore` Typert Remote 发送到宿主端的 `dsh-tool-a2ui-store` 控制器，因此浏览器从不直接接触文件系统。重新打开一个工具会向当前会话追加一条新的 `a2ui/surface` 记录，由既有的 `ui-a2ui` 投影渲染为交互式聊天节点。文案位于 `a2uiStore` 语言命名空间（中英双语）；该插件无需任何配置。

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

挂载该插件后，侧边栏底部会出现一个 A2UI 工具入口。打开它即可看到所有已保存的工具；点击某个工具的标题可在当前会话中打开该页面，点击其垃圾桶按钮可删除已保存的文件。当没有打开的会话、或加载/打开失败时，弹层会显示相应提示。

### 装配

随附的 web-app bundle 会在 `ui-a2ui` 之后将该插件行插入浏览器花名册：

```yaml
- id: ui-a2ui-store
  name: '@deepseek-ai/dsh-client-ui-a2ui-store'
```

该行不携带任何配置。浏览器插件注入 `slots`、`locale`、`remote` 与 `remote.a2uiStore`；`remote.a2uiStore` 命名空间来自 `dsh-api-remotes` 客户端装配，它挂载了 `dsh-tool-a2ui-store` 的 Remote 贡献。节点半边（`@deepseek-ai/dsh-client-ui-a2ui-store` 根入口）保持空闲，因为整个功能都在浏览器侧，与 `ui-a2ui` 一致。

### 重新打开已保存的工具

打开一个工具会调用 `a2uiStore.open(sessionId, name)`。宿主控制器读取已保存的页面 JSON，并向目标会话追加一条新的 `a2ui/surface` 事件；随后 `ui-a2ui` 会像模型刚生成它一样在对话中渲染，因此页面是可交互的，其提交也会返回给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

该插件注册一个 `sidebar.footer.action` 列表条目（`id: a2ui-store`），其注入 face 包含三个动词。`listTools` 调用 `remote.a2uiStore.list()` 并将 `RemoteResult` 解包为 `{ tools }`；`openTool(sessionId, name)` 与 `removeTool(name)` 以同样方式解包，在 Remote 失败时抛出，以便面板的错误状态捕获。面板组件通过全局 `useSessions` hook 读取当前会话（`state.current`），用本地 `closed | loading | ready | error` 阶段状态维护弹层，并通过 `useDismissOnOutsidePointer` 在外部点击时关闭。删除按钮在删除成功后更新本地列表。文案位于 `a2uiStore` 语言命名空间，含完整中英字典，条目沿用标准的槽位语言座位。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- `packages/web/tool-a2ui-store` — 宿主侧工具库：`a2ui_export` 工具、`a2uiStore` 能力，以及 `a2uiStore` Remote 控制器（`list`/`open`/`remove`）。
- `packages/client/ui-a2ui` — 将重新打开的页面渲染为交互式聊天节点的投影。
- `packages/api/remotes` — 挂载 `a2uiStore` Remote 贡献的客户端装配。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，其侧边栏面板列出并删除已保存的 A2UI 工具，不改变模型上下文。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 弹层按已保存的文件名列出工具；除页面标题外没有重命名或预览。
- 删除工具会立即删除已保存的文件；没有确认步骤。
- 工具库目录是 Harness 主目录下的 `a2ui-tools`；部署暂时无法将面板指向其他目录。

-----

<a id="dev-note"></a>
### 开发备注

该面板完全在浏览器侧；其宿主孪生是 `dsh-tool-a2ui-store`。将 Remote 的线上类型放在 `dsh-tool-a2ui-store/types`（一个客户端安全、不含值的模块）中，正是 `dsh-api-remotes` 能在不把仅宿主代码拖过边界的情况下将它们重新导出给浏览器的原因。
