# Agent Note: A2UI field logic and declarative actions

Status: implemented

English | [中文](2026-09-07-a2ui-field-logic-and-actions.zh.md)

## Problem

Model-authored A2UI pages could only collect input: a field was either filled or not, and the page vocabulary deliberately gave up validation rules and scripted interactivity in favor of a shape the browser could trust. Teams therefore could not express live field logic (show/hide, cross-field validation, derived values) or attach real operations to a page — every page ended at a plain submit that handed the collected values back to the model.

## Decision

Two orthogonal additions, both model-authored in the same `a2ui_surface` page JSON:

- **Field logic (browser-evaluated).** Each field may carry a `visibleWhen` expression (hidden while falsy), a `validateWhen` + `validateMessage` pair (submit refused while falsy), or a `compute` expression (read-only derived value that the submission payload carries). A field `name` must be a plain identifier so expressions can reference siblings by bare name; the tool schema validates the identifier and the `validateMessage`/`compute`-cannot-be-`required` constraints.
- **Declarative actions (model-dispatched).** The page may carry `actions`, each an `id`, `label`, a `tool` name, and an `instruction`. An action renders as a button beside submit; clicking it serializes the collected values as an ordinary `user/message` carrying `{ a2uiAction: { surfaceId, actionId, tool, instruction, values } }`. The model then invokes the named tool with those values. This stays on the existing submit path because, in the harness, tool execution is always model-dispatched — the same reason user `/name` skill invocation flows through the model.

The expression grammar is restricted and side-effect-free — literals (`string`/`number`/`true`/`false`/`null`), bare sibling-field references, `=== !== == != < <= > >= && || ! + - * / %`, parentheses, and the string helpers `.length`/`.trim()`/`.includes(x)`/`.startsWith(x)`/`.endsWith(x)`/`.toLowerCase()`/`.toUpperCase()` — and is evaluated by a recursive-descent interpreter (`a2ui-expression.ts`), never `eval` or `new Function`, so model text cannot reach ambient globals. A malformed expression degrades permissive (show / accept / empty) rather than hiding or blocking a field the user must reach.

## Alternatives considered

**Evaluate expressions with `eval` / `new Function`.** Rejected: model output is untrusted input, and the browser half must never run arbitrary model text; the small grammar keeps the whole surface auditable.

**Run actions through a host-side execution environment (direct tool RPC).** Rejected as out of scope for this step: tool execution in the harness is owned by the model loop, and a page-triggered call has no agent-turn context to run in. Serializing the trigger as a `user/message` reuses the existing submission channel and preserves the model-visible ⟺ logged invariant.

**A richer expression language (object/array literals, ternary, function calls).** Rejected: each added construct widens the audit surface without a demonstrated consumer; the string helpers cover the field-linking cases that motivated the feature.

## Consequences

The `a2ui/surface` page vocabulary now carries live field logic and named actions. Field values are normalized for expression evaluation (`number` fields become numbers, `checkbox` fields booleans) while the raw input still drives the submission payload, so a `validateWhen` like `age >= 18` sees a number rather than a string. Submissions still arrive as `user/message`; action triggers arrive as a distinct `a2uiAction` envelope so the model can distinguish "collect" from "run this tool". Both page kinds (form and canvas) render actions; canvas actions carry the arranged `graph` instead of field values.
