# Agent Note: A2UI 字段逻辑与声明式动作

Status: implemented

[English](2026-09-07-a2ui-field-logic-and-actions.md) | 中文

## Problem

模型生成的 A2UI 页面只能收集输入：字段要么填了要么没填，页面词汇刻意放弃了校验规则与脚本交互，以换取浏览器可信任的形状。因此团队无法表达实时字段逻辑（显隐、跨字段校验、派生值），也无法给页面挂接真实操作——每个页面都止步于一次普通提交，把收集到的值交还给模型。

## Decision

两项正交的扩展，都由模型写在同一份 `a2ui_surface` 页面 JSON 里：

- **字段逻辑（浏览器求值）。** 每个字段可携带 `visibleWhen` 表达式（为假时隐藏）、`validateWhen` + `validateMessage` 对（为假时拒绝提交），或 `compute` 表达式（只读派生值，提交载荷携带该值）。字段 `name` 必须是普通标识符，使表达式能按裸名引用兄弟字段；工具 schema 校验该标识符，以及 `validateMessage` 需配合 `validateWhen`、`compute` 字段不得 `required` 等约束。
- **声明式动作（由模型派发）。** 页面可携带 `actions`，每个为 `id`、`label`、`tool` 名与 `instruction`。动作渲染为提交按钮旁的按钮；点击后把收集值序列化为一条普通 `user/message`，携带 `{ a2uiAction: { surfaceId, actionId, tool, instruction, values } }`，模型随后用这些值调用该工具。这沿用了现有提交路径，因为在 harness 中工具执行总是由模型派发——正如用户 `/name` 技能调用也要经过模型。

表达式语法受限且无副作用——字面量（`string`/`number`/`true`/`false`/`null`）、裸兄弟字段引用、`=== !== == != < <= > >= && || ! + - * / %`、括号，以及字符串助手 `.length`/`.trim()`/`.includes(x)`/`.startsWith(x)`/`.endsWith(x)`/`.toLowerCase()`/`.toUpperCase()`——由递归下降解释器（`a2ui-expression.ts`）求值，绝不使用 `eval` 或 `new Function`，因此模型文本无法触及环境全局。畸形表达式按宽松降级（显示／接受／空值），而不会隐藏或阻断用户必须触达的字段。

## Alternatives considered

**用 `eval` / `new Function` 求值表达式。** 否决：模型输出是不可信输入，浏览器半层绝不能运行任意模型文本；小语法让整个表面可审计。

**通过宿主侧执行环境直接跑动作（直接工具 RPC）。** 否决为超出本步范围：harness 中工具执行归模型循环所有，页面触发的调用没有可运行的 agent 回合上下文。把触发序列化为 `user/message` 复用了现有提交通道，并保持了「模型可见 ⟺ 已记录」不变量。

**更丰富的表达式语言（对象/数组字面量、三元、函数调用）。** 否决：每增加一个构造都扩大审计面，却没有已证实的消费方；字符串助手已覆盖催生该功能的字段联动场景。

## Consequences

`a2ui/surface` 页面词汇现在携带实时字段逻辑与命名动作。字段值在表达式求值前被规范化（`number` 字段变数字、`checkbox` 字段变布尔），而原始输入仍驱动提交载荷，因此 `validateWhen` 如 `age >= 18` 看到的是数字而非字符串。提交仍以 `user/message` 到达；动作触发以独立的 `a2uiAction` 信封到达，使模型能区分「收集」与「运行此工具」。两种页面类型（表单与画布）都渲染动作；画布动作携带排布好的 `graph` 而非字段值。
