---
description: "The model-facing a2ui_surface tool: how deployments mount it, choose the update policy, and observe the model-authored form or canvas pages it opens in the web UI and records in the durable session log."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-a2ui-surface

English | [中文](README.zh.md)

## Summary

With `dsh-tool-a2ui-surface`, the model can open an interactive page in the web UI instead of collecting structured input through free text: it authors a declarative page JSON — a fillable form or a draggable node canvas — and the browser draws the page natively from the durable session log. Each call appends one `a2ui/surface` record to the calling agent's session, so the page survives refresh, replay, and later session opens. The user's submission returns to the model as an ordinary `user/message` carrying the same `surfaceId` and the collected payload, which keeps the round trip inside the message loop the model already understands. The page vocabulary is deliberately small (five field kinds and one node-graph shape) so the browser can trust and replay the record; a deployment chooses whether the model may refine an existing surface through the required `allowUpdate` config.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package wherever an agent should offer structured forms or arrangeable node graphs: it registers the `a2ui_surface` tool on the tools registry and appends durable page records to the owning session. The shipped web client renders the page through `dsh-client-ui-a2ui`; a surface without a native renderer shows only the short rendered tool result.

### When to choose it

Choose this package when the agent must collect structured input the user can fill in or arrange, and the user is on a surface that renders the page natively. Avoid it when the flow needs the collected values inside the same tool call, or needs widgets or layout the declarative vocabulary cannot express; those flows keep using plain messages or a tool that returns data directly.

### Minimal configuration

The `standard` agent preset and the base bundle mount the tool open-only; a composition that does not use them adds the row to its own agent plane:

```yaml
- id: tool-a2ui-surface
  name: '@deepseek-ai/dsh-tool-a2ui-surface'
  config:
    allowUpdate: false
```

The surrounding composition supplies the tools registry and the agent loop whose calls carry an owning session. The row is the deployment choice; the model-facing schema never changes with it.

| Field | Default | Meaning |
|---|---|---|
| `allowUpdate` | required | Whether the model may pass an explicit `surfaceId` to open a refined page under an existing surface identity; `false` always mints a fresh surface per call |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-a2ui-surface) is the exhaustive source for every accepted field and its JSDoc.

### The interaction loop

The model calls `a2ui_surface` with a `page` whose `kind` is `form` or `canvas`. The tool validates the page, appends one `a2ui/surface` record `{ surfaceId, page }` to the calling session, and returns `{ surfaceId, accepted, pageKind, fieldCount, nodeCount, edgeCount }`. The web client projects the logged record into an interactive node; the user fills the form or arranges the graph and submits. The submission becomes an ordinary `user/message` whose text is `{"a2uiSubmit": { ... }}` with the same `surfaceId` and the collected `values` or `graph`, and the model continues from that message. A call outside an agent loop has no owning session and fails; schema and value violations fail the call before any record is appended.

### Replacing a surface

With `allowUpdate: true`, the model may pass the stable `surfaceId` of an earlier page so a flow can refine a page after the user submits; with `false`, any explicit `surfaceId` is rejected and every call mints a fresh identity. Replacement never rewrites history: the log is append-only, so each call adds its own record and the renderer opens each record as its own transcript row. The model correlates the user's later submissions with its pages by `surfaceId`, so a reused identity means "continue the same logical surface", not "delete the earlier row".

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tool owns two jobs: keep the logged page equal to what the model believes it wrote, and append it to the durable log. The registry schema (`additionalProperties: false` at every object level, strict enums) rejects unknown keys and widget kinds before execution; the package then validates the value constraints a JSON schema cannot express — trimmed non-empty `title`, unique trimmed field names and node ids, at least one option per `select`, finite node positions, no self-loop, edges whose endpoints exist — and canonicalizes the page before appending. The surface identity is either the model-supplied `surfaceId` (updates enabled) or a freshly minted `a2ui-…` id. The package also publishes an invariant companion (`@deepseek-ai/dsh-tool-a2ui-surface/invariant`) that validates durable `a2ui/surface` records on cold load and live append, because the browser renderer trusts the log shape and a record that cannot render must fail loud.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, page canonicalization, tool registration, session append |
| [`src/types.ts`](src/types.ts) | Browser-safe page vocabulary shared with the renderer, plus the `a2ui/surface` `SessionEventMap` merge |
| [`src/invariant.ts`](src/invariant.ts) | Package-owned invariant companion validating durable surface records |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the renderer to the exact model-facing schema, the logged record, and the design rationale.

- [dsh-client-ui-a2ui](../../client/ui-a2ui/README.md) — the web client renderer that draws the page and sends the submission.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-a2ui-surface) — the exact `a2ui_surface` description and schema.
- [Generated durable-event catalog](../../../docs/persistence-catalog.md#a2uisurface--log-only) — the logged record and its replay contract.
- [Model-authored A2UI pages note](../../../.agents/notes/implemented/feature/2026-08-20-a2ui-model-authored-form-pages.md) — why a durable declarative page plus an ordinary submission message was chosen.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the `a2ui_surface` name, its static description, and the exact JSON schema recorded in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-a2ui-surface). The description tells it to choose the page `kind` that fits the task, give every `field` a unique `name` and a human `label`, set `required` only for mandatory input, and seed `select` fields with `options`; a canvas page seeds `nodes` (stable `id`, `label`, optional `detail` and `role`, initial `position`) and `edges`. `surfaceId` is an optional second argument whose meaning depends on the deployment's update policy, never on the schema.

#### Token effect

Fixed description-and-schema cost on every request where the tool is visible to the agent. The whole page vocabulary — five field widget kinds plus canvas node and edge fields — rides in the schema, so this definition is heavier than a scalar-argument tool.

#### KV Cache effect

Prefix-stable while the registered definition and its visibility are unchanged; `allowUpdate` changes execution policy, never the description or schema. Plugin lifecycle or a scoped tool restriction may invalidate reuse from the first changed schema token.

### Tool call and result

#### What the model sees

The tool call keeps the authored page JSON in history. Success renders exactly `Rendered A2UI surface <surfaceId> with <fieldCount> fields.` for a form, or `Rendered A2UI surface <surfaceId> with <nodeCount> nodes and <edgeCount> edges.` for a canvas. A call without an owning agent session fails with `a2ui_surface requires an owning agent session`; passing `surfaceId` while updates are disabled fails with `a2ui_surface cannot replace a surface: updates are disabled by this deployment`; schema and value violations return error results whose text carries the exact rejection, such as `invalid a2ui page: duplicate field name "a"` or ``a `select` field needs at least one option``.

#### Token effect

Authored page arguments stay in retained history until compaction and scale with the page the model wrote; the rendered result is short fixed text plus the counts.

#### KV Cache effect

Append-only; the call and result follow the reusable request prefix and do not invalidate existing KV-cache entries.

### Later user submission

#### What the model sees

After the user submits, the next model input is an ordinary `user/message` whose text is the JSON `{"a2uiSubmit": {"surfaceId": "<surfaceId>", "values": {…}}}` for a form, or the same envelope with a `graph` member for a canvas, carrying the exact `surfaceId` the model's call opened or replaced. The tool never renders the payload; the model correlates the submission with its page by that identity.

#### Token effect

The submission is ordinary user-turn content and is resent until compaction like any other message.

#### KV Cache effect

Append-only; the submission follows the reusable prefix as any user turn does and invalidates nothing by itself.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tool cannot express a flow or needs a renderer; they are current package constraints, not a task backlog.

- **The page vocabulary is deliberately small** — five field kinds and one node-graph shape; rich layout, expression-level validation rules, and scripted interactivity have no declarative form, and the record is exactly the minimal page the renderer can draw.
- **A submission is not a tool result** — the opening call returns immediately with counts; the collected payload arrives later as an ordinary user message, so the model must close its turn and wait instead of reading values synchronously.
- **A page renders only where a native renderer is assembled** — without `dsh-client-ui-a2ui` (the shipped web client), the model can still open a surface but the user sees only the short rendered tool result, not interactive controls.
- **Nothing rewrites an earlier page** — the log is append-only; an update flow appends a refined page under the same `surfaceId`, and the earlier record stays in the log and on screen.
- **Update flows are a deployment choice** — with `allowUpdate: false` every explicit `surfaceId` is rejected; a deployment that needs refined pages must set `allowUpdate: true` in its own composition.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
