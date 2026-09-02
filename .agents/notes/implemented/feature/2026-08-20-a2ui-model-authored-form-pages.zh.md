# Agent Note: 模型生成的 A2UI 表单页

Status: implemented

[English](2026-08-20-a2ui-model-authored-form-pages.md) | 中文

## 问题

开放式提问让模型猜测用户意图。需要反复收集结构化输入的 agent 无法呈现可填写的表单，而模型生成的 UI 也无法持久化：模型绘制的页面只存在于其进程运行期间，刷新或稍后重新打开 Session 就会丢失。Web Client 已经能从持久 Session 事件组装业务拥有的 Conversation Node，因此模型生成的页面需要：把页面写入调用 Session 的生产方、能经受重放的持久记录，以及把它绘制为原生表单的客户端 renderer。

## 决策

`dsh-tool-a2ui-surface` 在宿主工具注册表注册 `a2ui_surface` 工具。工具接收声明式 `page` 对象（`title`、可选 `description`、`submitLabel`、`instruction` 以及由 `text`、`textarea`、`select`、`number`、`checkbox` 控件组成的非空 `fields` 数组）和可选 `surfaceId`。注册表 schema 强制字段枚举并拒绝未知键，因此落库页面始终等于模型以为它写下的内容。工具随后校验 schema 无法表达的值约束——非空且已修剪的标题、唯一且非空的修剪字段名、每个 `select` 至少一个选项——并向调用 Agent 的 Session 追加一条持久 `a2ui/surface` 事件 `{ surfaceId, page }`。没有所属 Agent Session 的调用者会被拒绝。

`allowUpdate` 配置必填、无默认值，且控制替换能力。`false`（base bundle 与 standard 预设的选择）每次调用铸造全新 `surfaceId`，并拒绝任何显式 `surfaceId`；`true`（天问星预设的选择）允许模型传入稳定 `surfaceId` 替换既有表面，使流程能在用户提交后细化页面。包 invariant 在冷加载与实时 append 时都拒绝无效或未修剪的 surface 记录，因为浏览器 renderer 信任日志形状：无法渲染的记录大声失败，而不是静默劣化 UI。

用户提交从不写入新的持久节点。面板把收集到的值序列化为携带 `{"a2uiSubmit": {"surfaceId", "values"}}` 的 `user/message`，并通过普通输入机发送，因此模型把提交内容当作按同一 `surfaceId` 键控的普通消息接收。

`dsh-client-ui-a2ui` 注册一个 `a2ui-surface` Conversation Definition 和一个 keyed Chat renderer。定义把每条 `a2ui/surface` 事件匹配为独立 `start`（页面打开后不存在更新状态），用 `surfaceId#seq` 键控每个节点，使刻意复用的 `surfaceId` 打开新行而不是冲突，并以开页事件锚定节点。`A2uiPanel` 把页面原生渲染为表单：text、textarea、select、number、checkbox 控件、必填校验，以及在输入机处于 adjudicating、claimed 或 submitting 时拒绝提交的忙碌守卫。本地化文案位于 `a2ui` 命名空间（zh + en）。

装配把两半都挂到已发布表面上：base bundle 与 `standard` agent 预设注册工具（仅开页），`web-app` bundle 注册 `ui-a2ui` 客户端插件并禁用 base 工具行，使每个会话通过其预设挂载工具，天问星预设启用更新。工具与持久化目录从已发布 schema 和扩展后的 `SessionEventMap` 重新生成。

## 验证

包测试驱动真实插件与真实 Session：schema 形状、修剪存储、全新铸造、显式替换、仅开页拒绝、畸形页面拒绝、非 agent 拒绝与 HMR 注销。客户端测试覆盖 Conversation 投影（独立 start 行、无更新状态）与面板（字段渲染、必填校验、忙碌拒绝、提交载荷）。仓库门禁通过：typecheck、包测试、`verify-cordis-config`，以及重新生成的工具与持久化目录。

## 备选方案

**通过专用通道把页面返回客户端。** 拒绝：Session 日志已经提供持久化、实时投递、重放与缺口修复；第二条传输会重复同样的事实并产生第二个生命周期 owner。

**持久化完整 UI 树并让模型命令式编辑。** 拒绝：已发布的记录是 renderer 能绘制的最小声明式页面；命令式编辑协议需要自己的持久性与重放规则，且不增加用户可见能力。

**在既有工具卡内渲染页面。** 拒绝：`ui-tool` 与工具定义拥有该行呈现；交互式表单是独立业务生命周期，需要自己的 keyed node。

**把提交作为工具结果发送。** 拒绝：用户在工具调用返回后才行动；提交是一个新的用户回合，以模型已经理解的普通 `user/message` 到达。

## 影响

模型生成的表单如今与对话同一日志地经受刷新与恢复，并在 Web Client 中原生渲染，替代收集结构化输入时的开放式提问。该变更新增一个工具、一条持久事件、一个客户端 renderer 与一个包 invariant；部署按预设选择替换策略。页面词汇刻意保持精简（五种字段），放弃丰富布局、校验规则与脚本化交互，换取浏览器可信且可重放的形状。
