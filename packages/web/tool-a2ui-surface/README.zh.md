---
description: "面向模型的 a2ui_surface 工具：部署方如何挂载它、选择更新策略并观察模型创作的表单或画布页面——这些页面在 web UI 中原生渲染并写入持久会话日志。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-a2ui-surface

[English](README.md) | 中文

## 概述

有了 `dsh-tool-a2ui-surface`，模型可以不再用自由文本收集结构化输入，而是在 web UI 中打开一个交互式页面：它创作一段声明式页面 JSON——可填写的表单或可拖拽的节点画布——浏览器根据持久会话日志原生绘制该页面。每次调用都会向所属 agent（智能体）的会话追加一条 `a2ui/surface` 记录，因此页面在刷新、回放与之后重新打开会话时依然存在。用户提交以普通 `user/message` 返回给模型，携带相同的 `surfaceId` 与收集到的载荷，这让往返过程保持在模型已经理解的消息循环之内。页面词表刻意保持很小（五种字段控件与一种节点图形状），浏览器才能信任并回放记录；是否允许模型通过必填的 `allowUpdate` 配置精化既有 surface，由部署方选择。

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

在需要 agent 提供结构化表单或可编排节点图的任何位置挂载本包：它把 `a2ui_surface` 工具注册到工具注册表，并把持久页面记录追加到所属会话。随产品交付的 web 客户端通过 `dsh-client-ui-a2ui` 渲染页面；没有原生渲染器的 surface 只显示简短的渲染后工具结果。

### 何时选择

当 agent 必须收集用户可填写或可编排的结构化输入、且用户所在界面原生渲染该页面时，选择本包。当流程需要在同一次工具调用内拿到收集值，或需要声明式词表无法表达的小部件与布局时，避免使用它；这些流程继续使用普通消息或直接返回数据的工具。

### 最小配置

`standard` agent 预设与 base bundle 以 open-only 方式挂载该工具；不使用它们的组合需把该行加入自己的 agent 平面：

```yaml
- id: tool-a2ui-surface
  name: '@deepseek-ai/dsh-tool-a2ui-surface'
  config:
    allowUpdate: false
```

外围组合提供工具注册表与调用时携带所属会话的 agent loop。该行是部署选择；面向模型的 schema 从不随它改变。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `allowUpdate` | 必填 | 模型是否可传入显式 `surfaceId` 以在既有 surface 身份下打开精化页面；`false` 每次调用都铸新 surface |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-a2ui-surface)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 交互循环

模型以 `kind` 为 `form` 或 `canvas` 的 `page` 调用 `a2ui_surface`。工具验证页面、向所属会话追加一条 `a2ui/surface` 记录 `{ surfaceId, page }`，并返回 `{ surfaceId, accepted, pageKind, fieldCount, nodeCount, edgeCount }`。web 客户端把已记录页面投影为可交互节点；用户填写表单或编排图形并提交。提交变成一条普通 `user/message`，其文本为 `{"a2uiSubmit": { ... }}`，携带相同的 `surfaceId` 与收集到的 `values` 或 `graph`，模型从该消息继续。agent loop 之外的调用没有所属会话而失败；schema 或值违规在追加任何记录前就让调用失败。

### 替换 surface

当 `allowUpdate: true` 时，模型可传入先前页面的稳定 `surfaceId`，使流程能在用户提交后精化页面；为 `false` 时，任何显式 `surfaceId` 都被拒绝，每次调用都会铸一个新身份。替换从不重写历史：日志只追加，因此每次调用都会加入自己的记录，渲染器把每条记录打开为独立会话行。模型靠 `surfaceId` 把用户后续提交与其页面关联起来，因此复用身份的含义是“继续同一个逻辑 surface”，而不是“删除更早的行”。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

该工具有两项职责：让已记录页面与模型认为自己写下的内容一致，并把它追加到持久日志。注册表 schema（每一层对象都 `additionalProperties: false`，枚举严格）在执行前拒绝未知键与未知控件类型；包随后验证 JSON schema 无法表达的值约束——去空白后非空的 `title`、唯一且去空白后的字段名与节点 id、每个 `select` 至少一个选项、有限的节点坐标、无自环、端点存在的边——并在追加前把页面规范化。surface 身份或是模型提供的 `surfaceId`（允许更新时），或是新铸的 `a2ui-…` id。本包还发布不变式伴生插件（`@deepseek-ai/dsh-tool-a2ui-surface/invariant`），在冷加载与实时追加时校验持久 `a2ui/surface` 记录，因为浏览器渲染器信任日志形状，无法渲染的记录必须大声失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、页面规范化、工具注册、会话追加 |
| [`src/types.ts`](src/types.ts) | 与渲染器共享的浏览器安全页面词表，以及 `a2ui/surface` 的 `SessionEventMap` 合并 |
| [`src/invariant.ts`](src/invariant.ts) | 包自有不变式伴生插件，校验持久 surface 记录 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从渲染器逐步进入精确的面向模型 schema、已记录事件与设计理由。

- [dsh-client-ui-a2ui](../../client/ui-a2ui/README.zh.md)——绘制页面并发送提交的 web 客户端渲染器。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-a2ui-surface)——精确的 `a2ui_surface` 描述与 schema。
- [生成的持久事件目录](../../../docs/persistence-catalog.zh.md#a2uisurface--log-only)——已记录事件及其回放约定。
- [模型创作的 A2UI 页面说明](../../../.agents/notes/implemented/feature/2026-08-20-a2ui-model-authored-form-pages.zh.md)——为何选择持久声明式页面加普通提交消息。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到的内容

模型看到 `a2ui_surface` 名称、静态描述，以及生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-a2ui-surface)中记录的精确 JSON schema。描述告诉它选择符合任务的页面 `kind`，给每个 `field` 一个唯一 `name` 与人类可读 `label`，只为必填输入设置 `required`，并给 `select` 字段提供 `options`；canvas 页面则提供 `nodes`（稳定 `id`、`label`、可选 `detail` 与 `role`、初始 `position`）与 `edges`。`surfaceId` 是可选第二参数，其含义取决于部署的更新策略，而不是 schema。

#### Token 影响

工具对 agent 可见的每个请求都有固定的描述加 schema 成本。整个页面词表——五种字段控件加 canvas 节点与边字段——都在 schema 里，因此该定义比标量参数工具更重。

#### KV Cache 影响

当已注册定义及其可见性不变时前缀稳定；`allowUpdate` 只改变执行策略，绝不改变描述或 schema。插件生命周期或 scope 工具限制可能从首个被改变的 schema token 起使复用失效。

### 工具调用与结果

#### 模型看到的内容

工具调用把模型创作的页面 JSON 保留在历史中。成功时表单精确渲染为 `Rendered A2UI surface <surfaceId> with <fieldCount> fields.`，canvas 渲染为 `Rendered A2UI surface <surfaceId> with <nodeCount> nodes and <edgeCount> edges.`。没有所属 agent 会话的调用以 `a2ui_surface requires an owning agent session` 失败；更新被禁用时传入 `surfaceId` 以 `a2ui_surface cannot replace a surface: updates are disabled by this deployment` 失败；schema 或值违规返回错误结果，其文本携带精确拒绝原因，例如 `invalid a2ui page: duplicate field name "a"` 或 ``a `select` field needs at least one option``。

#### Token 影响

模型创作的页面参数会保留在历史中直到压缩，并随模型写下的页面大小而增长；渲染结果是简短固定文本加计数。

#### KV Cache 影响

只追加；调用与结果跟随可复用请求前缀，不使既有 KV-cache 条目失效。

### 随后的用户提交

#### 模型看到的内容

用户提交后，下一个模型输入是一条普通 `user/message`，其文本是 JSON `{"a2uiSubmit": {"surfaceId": "<surfaceId>", "values": {…}}}`（表单），或携带 `graph` 成员的同一信封（canvas），携带模型调用所打开或替换的精确 `surfaceId`。工具从不渲染该载荷；模型靠该身份把提交与其页面关联。

#### Token 影响

提交是普通用户轮次内容，与其他消息一样保留到压缩时。

#### KV Cache 影响

只追加；提交像任何用户轮次一样跟随可复用前缀，本身不使任何条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义该工具何时无法表达某种流程或需要渲染器；它们是当前包约束，不是任务积压。

- **页面词表刻意保持很小**——五种字段控件与一种节点图形状；富布局、表达式级校验规则与脚本化交互没有声明式形式，记录恰好是渲染器能绘制的最小页面。
- **提交不是工具结果**——打开调用立即以计数返回；收集到的载荷稍后以普通用户消息到达，因此模型必须结束自己的轮次等待，而不是同步读取值。
- **页面只在装配了原生渲染器的地方渲染**——没有 `dsh-client-ui-a2ui`（随产品交付的 web 客户端）时，模型仍可打开 surface，但用户只能看到简短的渲染后工具结果，没有交互控件。
- **任何内容都不会改写更早的页面**——日志只追加；更新流程在相同 `surfaceId` 下追加精化页面，更早的记录仍留在日志与屏幕上。
- **更新流程是部署选择**——`allowUpdate: false` 时任何显式 `surfaceId` 都被拒绝；需要精化页面的部署必须在自己组合中设置 `allowUpdate: true`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
