---
description: "dsh web 客户端中面向模型创作的 A2UI 页面的渲染器：部署方如何把它加入浏览器名单，以及用户如何把每条持久 a2ui/surface 记录当作可交互的表单或 canvas 节点，其提交会返回给模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-a2ui

[English](README.md) | 中文

## 概述

`dsh-client-ui-a2ui` 是在 dsh web 客户端中绘制模型创作的 A2UI 页面的浏览器插件：它把每条持久 `a2ui/surface` 会话记录投影为可交互的 Chat 节点，根据声明式页面 JSON 原生渲染。用户填写表单字段或拖拽 canvas 节点与连线后提交；面板把收集到的载荷作为携带相同 `surfaceId` 的普通 `user/message` 发回模型，因此节点打开后不再需要任何状态。投影是确定性回放：每次打开事件都成为以 `surfaceId#seq` 为键的独立会话行，因此刻意复用的 surface 身份会打开新页面，而不是修改更早的页面。轮次中途打开的页面即使在紧凑 transcript 下关闭该轮次后，仍作为独立会话行保持可见。文案位于 `a2ui` locale 命名空间（中文与英文）；插件不需要任何配置。

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

挂载本插件后，会话日志中的每条 `a2ui/surface` 记录都会在对话中显示为可交互页面：填写表单或编排 canvas，然后提交。页面停留在模型打开它的位置，模型对提交的回答随后以普通 assistant 消息到达。

### 装配

随产品交付的 web-app bundle 把该插件行插入其浏览器名单：

```yaml
- id: ui-a2ui
  name: '@deepseek-ai/dsh-client-ui-a2ui'
```

该行不带任何配置。名单把插件放在 `ui-conversation` 与 `ui-chat` 之后，浏览器插件注入后者的服务（`uiConversation`、`slots`、`sessions`、`locale`）；node 半边（`@deepseek-ai/dsh-client-ui-a2ui` 根入口）保持惰性，因为整个功能都在浏览器侧。

### 填写表单

`form` 页面把模型创作的字段渲染为原生控件——`text` 与 `textarea` 输入框、`select` 下拉框、`number` 输入框与 `checkbox` 开关——页面标题、描述与指令显示在控件上方。标为 `required` 的字段显示必填徽标，并在持有值之前阻止提交；未勾选的必填 checkbox 始终无效。提交按钮在页面提供 `submitLabel` 时使用该标签，否则使用本地化默认文案。

### 编排 canvas

`canvas` 页面把种子节点渲染在可缩放、可平移的画布上：拖拽节点以移动它，从节点把手拖出以连接新箭头线，拉动既有连线的弯折把手以绕开节点布线或重连两端。双击节点卡片可内联编辑其标签与详情，双击连线或其标签片可重命名连线。节点卡片保留模型创作的标签、详情与可选 start/end 角色样式；节点不可删除，而选中的连线可用 Delete 或 Backspace 移除。

### 提交

面板先校验必填字段（表单），再用 JSON 提交文本 `{"a2uiSubmit": { ... }}` 替换输入框草稿，并经由普通输入机提交。当输入机处于 adjudicating、claimed 或 submitting 时，面板禁用提交控件并以本地化忙碌错误拒绝竞争提交。提交载荷携带节点的 `surfaceId` 与收集到的 `values`（表单）或编排好的 `graph`（canvas），发送后会话行仍保持可见。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包是一个确定性投影加一个 keyed renderer，都以 Cordis effect 注册：浏览器 `apply` 注册 Definition、`a2ui` 字典对与 `a2ui-surface` keyed Chat renderer，dispose 该 fiber 会撤销三者。

### 投影

`a2uiSurfaceDefinition` 把每条 `a2ui/surface` 事件匹配为独立 `start`，并以 `surfaceId#seq` 作为 Context 的键，因此复用的 `surfaceId` 绝不会与既有行冲突。页面打开后没有 update 状态：Definition 保留模型创作的页面，其 `update` 是 no-op。`buildViewNode` 输出锚定在打开事件的可见 Chat 行，并置 `turnProcessIndependent: true`，告诉 `ui-chat` 的 process folding：该页面是轮次中途打开的持久 surface，轮次关闭时必须保持可见而不是折叠。

### 渲染器

`A2uiPanel` 按页面的 `kind` 分流，并把共享 chrome（标题、描述、指令、校验错误、提交按钮）交给表单或 canvas 主体。表单面板按声明的控件类型为每个字段播种一个控件，并按类型强制转换载荷值。canvas 面板使用 React Flow（`@xyflow/react`）：自定义节点卡片（内联双击编辑、`start`/`end` 角色样式、不可删除）与用户可弯折、可重命名的自定义箭头边；节点位置与边的弯折只存在面板状态中，用户提交时才读取。两个面板都通过同一辅助函数（`a2uiSubmitMessage`）序列化，并借助每个 `conversation.chat.node` renderer 都会收到的会话级 `useInput`/`inputActions` props 驱动输入框。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | node 半边：惰性宿主插件（功能完全在浏览器侧） |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器插件入口：Definition 注册、字典、keyed renderer |
| [`src/client/a2ui-definition.ts`](src/client/a2ui-definition.ts) | `a2ui-surface` Conversation Definition 与 `ChatNodeDataMap` 载荷 |
| [`src/client/A2uiPanel.tsx`](src/client/A2uiPanel.tsx) | 表单与 canvas 渲染器之间的类型分流器 |
| [`src/client/a2ui-chrome.tsx`](src/client/a2ui-chrome.tsx) | 共享页面 chrome、忙碌/校验错误与提交序列化器 |
| [`src/client/A2uiFormPanel.tsx`](src/client/A2uiFormPanel.tsx) | 表单渲染器：按类型的字段控件、必填校验、载荷转换 |
| [`src/client/A2uiCanvasPanel.tsx`](src/client/A2uiCanvasPanel.tsx) | canvas 渲染器：React Flow 节点、可弯折边、连接/重连、提交投影 |
| [`src/client/locales.ts`](src/client/locales.ts) | `a2ui` 中英文词典 |
| [`src/invariant.ts`](src/invariant.ts) | 注册包所有权的不变式伴生插件；无运行时不变式（宿主工具包拥有持久记录不变式） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从生产该记录的工具逐步进入对话宿主与装配模型。

- [dsh-tool-a2ui-surface](../../web/tool-a2ui-surface/README.zh.md)——产生持久 `a2ui/surface` 记录的面向模型工具。
- [ui-conversation](../ui-conversation/README.zh.md)——装配宿主：Definition 注册表、Context 与 `conversation.chat.node` slot。
- [ui-chat](../ui-chat/README.zh.md)——渲染 keyed 节点并拥有 process folding 的 Chat target。
- [生成的持久事件目录](../../../docs/persistence-catalog.zh.md#a2uisurface--log-only)——已记录事件及其回放约定。
- [Conversation 子系统](../../../docs/subsystems/conversation.zh.md)——业务自有功能如何注册 Conversation node。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，只把持久 A2UI surface 记录渲染为可交互 Chat 节点，不改变模型上下文。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义渲染器能绘制什么、用户工作能保留多远；它们是当前包约束，不是任务积压。

- **每次打开都是独立会话行**——刻意复用的 `surfaceId` 会打开新节点，而不是合并或替换更早的页面；后来的页面到达后，每一行都保持可见且可提交。
- **进行中的用户编辑不持久**——表单值与 canvas 编排只存在于面板状态；刷新或 renderer remount 会从日志回放模型创作的页面，并丢弃未发送的编辑。
- **提交是普通输入框消息**——载荷以 JSON 文本经普通输入机发出，输入机忙碌时面板拒绝提交；消息循环之外没有结构化提交通道。
- **只有 Chat target 渲染 surface**——Definition 以 `chat` 为目标；trajectory 与其他对话视图不显示 surface 节点。
- **渲染器只绘制声明过的词表**——表单字段与 canvas 图形原生渲染，但客户端不会在模型创作集合之外增加控件类型。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
