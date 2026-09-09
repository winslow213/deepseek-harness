# Agent Note：A2UI 脚本化本地动作

Status: implemented

[English](2026-09-09-a2ui-scripted-local-actions.md) | 中文

## 问题

一个 `local` A2UI 动作此前只能运行单个表达式并显示其结果。一个工具页面若需要在一次点击后执行多个确定性操作——给一个字段赋值、向另一个字段拼接内容、重新加载数据源、停止正在运行的采集——除了走模型往返（`model` 动作）或主机往返（`command`/`script` 动作）之外，没有别的表达方式。[动态数据源与实时结果提案](../../proposed/feature/2026-09-08-a2ui-dynamic-data-and-live-results.zh.md) 把它列为第三项能力：`local` 动作上的声明式步骤列表，按顺序由浏览器已有的表达式语法执行，绝不运行任意模型文本。

## 决策

本决策取代 [A2UI 动态数据源与实时结果](../../proposed/feature/2026-09-08-a2ui-dynamic-data-and-live-results.zh.md) 中的脚本化本地动作能力（提案第 3 项）；该笔记不再承担任何未尽事项——第 1、2 项已分别实现。`local` 动作携带一个有序的 `steps` 列表，包含四种受限操作。

- **步骤词表。** `A2uiStep` 是一个封闭联合：`set`（把表达式结果赋给字段）、`append`（把表达式结果拼接到字段当前值上）、`refresh`（重新发起某个 `select` 字段的 `source`）、`stop`（终止页面关联的正在运行的作业）。`set`/`append` 携带 `field` 和 `value` 表达式；`refresh` 携带 `source` 名；`stop` 不带参数。
- **校验失败即报错。** `canonicalizeA2uiPage` 拒绝未知步骤类型、`field` 不是标识符或 `value` 为空的 `set`/`append`、`source` 为空的 `refresh`，以及——在字段列表规范化之后的跨引用校验中——指向页面未声明字段的 `set`/`append`、指向无 `select` 字段声明的源的 `refresh`。canvas 页面（无字段、无源）只接受 `stop`。
- **按顺序解析。** `invokeAction` 按声明顺序对一张工作值表解析步骤列表，因此后续步骤能看到前面步骤的写入。`set`/`append` 收敛为字段最终值（`append` 已完成拼接）；`refresh`/`stop` 作为 opener 意图透传。`result` 表达式仍作为动作文本显示。
- **浏览器执行。** 独立弹窗宿主执行解析后的步骤：字段写入汇成一次批量 patch 回写表单面板，`refresh` 重新发送 `a2ui/data-request`，`stop` 发送新的 `a2ui/stop` 消息（携带当前 command 的 `runId`）。launcher 把 `a2ui/stop` 转发给运行桥接（`stopRun`）。
- **stop 保持可点击。** chrome 在提交/运行进行中会禁用所有动作按钮，这会阻止 `stop` 步骤去终止那个使页面忙碌的运行。携带 `stop` 步骤的 `local` 动作被豁免于忙碌禁用，因此用户始终可以终止关联作业。

## 考虑的替代方案

**在主机上运行步骤。** 拒绝：`set`/`append` 修改的是主机并不持有的浏览器端表单状态，且提案明确使用浏览器已有的求值语法，纯字段逻辑无需主机往返。

**让步骤运行任意 JavaScript。** 拒绝：受限语法存在的目的正是让浏览器绝不执行任意模型文本；四种声明的操作使每个效果都保持声明式、可记录、受能力约束。

**复用 `optionsFrom` 脚本动作来实现 `refresh`。** 拒绝：`refresh` 命名的是受信任的 `source`，而非可执行逻辑；数据源提供方已负责源解析，因此 `refresh` 步骤复用同一条 `a2ui/data-request` 往返。

## 后果

`local` 动作现在可以表达确定性多步操作，除真正需要之处（`refresh` 重载源、`stop` 终止运行）外不再产生任何模型或主机往返。`stop` 目前只终止 `command` 动作的运行；终止 `model` 动作的后台作业需要主机端 live stop（launcher 只知道 surface，不知道 job id），已延后。无效的步骤引用在规范化阶段即失败，因此格式错误的页面绝不会进入运行时。
