---
description: "The dsh web client renderer for model-authored A2UI pages: how deployments add it to the browser roster and how users see each durable a2ui/surface record as an interactive form or canvas node whose submission returns to the model."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-a2ui

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-a2ui` is the browser plugin that draws model-authored A2UI pages in the dsh web client: it projects each durable `a2ui/surface` session record into an interactive Chat node, rendered natively from the declarative page JSON. Users fill form fields or drag canvas nodes and edges, then submit; the panel sends the collected payload back to the model as an ordinary `user/message` carrying the same `surfaceId`, so the node needs no further state after it opens. The projection is deterministic replay: every opening event becomes its own standalone transcript row keyed by `surfaceId#seq`, so a deliberately reused surface identity opens a fresh page instead of mutating an earlier one. A page opened mid-turn stays visible as an independent transcript row even after the turn closes under the compact transcript. Copy lives in the `a2ui` locale namespace (zh and en); the plugin takes no configuration.

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

When this plugin is mounted, every `a2ui/surface` record in the session log appears in the conversation as an interactive page: fill the form or arrange the canvas, then submit. The page stays where the model opened it, and the model's answer to the submission follows as an ordinary assistant message.

### Assembly

The shipped web-app bundle inserts the plugin row into its browser roster:

```yaml
- id: ui-a2ui
  name: '@deepseek-ai/dsh-client-ui-a2ui'
```

The row carries no configuration. The roster places the plugin after `ui-conversation` and `ui-chat`, whose services the browser plugin injects (`uiConversation`, `slots`, `sessions`, `locale`); the node half (`@deepseek-ai/dsh-client-ui-a2ui` root entry) stays inert because the whole feature is browser-side.

### Filling in a form

A `form` page renders its model-authored fields as native controls — `text` and `textarea` inputs, `select` dropdowns, `number` inputs, and `checkbox` toggles — with the page title, description, and instruction above the controls. A field marked `required` shows the required badge and blocks submission until it holds a value; an unchecked required checkbox stays invalid. The submit button carries the page's `submitLabel` when present and otherwise the localized default copy.

### Arranging a canvas

A `canvas` page renders its seeded nodes on a zoomable, pannable pane: drag a node to move it, drag from a node handle to connect a new arrow line, and pull an existing line's bend handle to route it around nodes or reconnect its ends. Double-click a node card to edit its label and detail inline, and double-click a line or its label chip to rename the line. Node cards keep the model-authored label, detail, and optional start/end role styling; nodes cannot be deleted, while selected lines can be removed with Delete or Backspace.

### Submitting

The panel validates required fields (forms), then replaces the composer draft with the JSON submission text `{"a2uiSubmit": { ... }}` and submits it through the ordinary input machine. While the machine is adjudicating, claimed, or submitting, the panel disables the submit control and refuses racing submits with a localized busy error. The submission payload carries the node's `surfaceId` plus the collected `values` (form) or the arranged `graph` (canvas), and the transcript row stays visible after the send.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is one deterministic projection plus one keyed renderer, registered as Cordis effects: the browser `apply` registers the Definition, the `a2ui` dictionary pair, and the `a2ui-surface` keyed Chat renderer, and disposing the fiber retracts all three.

### The projection

`a2uiSurfaceDefinition` matches every `a2ui/surface` event as a standalone `start` match and keys the Context by `surfaceId#seq`, so a reused `surfaceId` can never collide with an existing row. There is no update state after the page opens: the Definition keeps the model-authored page and its `update` is a no-op. `buildViewNode` emits a visible Chat row anchored at the opening event with `turnProcessIndependent: true`, which tells `ui-chat`'s process folding that the page is a durable mid-turn surface that must stay visible instead of collapsing when the turn closes.

### The renderer

`A2uiPanel` narrows the page by its `kind` and hands the shared chrome (title, description, instruction, validation error, submit button) to the form or canvas body. The form panel seeds one control per field from the declared widget kind and coerces payload values by kind. The canvas panel uses React Flow (`@xyflow/react`) with a custom node card (inline double-click editing, styled `start`/`end` roles, non-deletable) and a custom arrow edge the user bends and renames; node positions and edge bends live in panel state and are read only when the user submits. Both panels serialize through one helper (`a2uiSubmitMessage`) and drive the composer through the session-scoped `useInput`/`inputActions` props that every `conversation.chat.node` renderer receives.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Node half: inert host plugin (the feature is entirely browser-side) |
| [`src/client/index.ts`](src/client/index.ts) | Browser plugin entry: Definition registration, dictionaries, keyed renderer |
| [`src/client/a2ui-definition.ts`](src/client/a2ui-definition.ts) | The `a2ui-surface` Conversation Definition and `ChatNodeDataMap` payload |
| [`src/client/A2uiPanel.tsx`](src/client/A2uiPanel.tsx) | Kind dispatcher between the form and canvas renderers |
| [`src/client/a2ui-chrome.tsx`](src/client/a2ui-chrome.tsx) | Shared page chrome, busy/validation error, and the submission serializer |
| [`src/client/A2uiFormPanel.tsx`](src/client/A2uiFormPanel.tsx) | Form renderer: per-kind field controls, required validation, payload coercion |
| [`src/client/A2uiCanvasPanel.tsx`](src/client/A2uiCanvasPanel.tsx) | Canvas renderer: React Flow nodes, bendable edges, connect/reconnect, submit projection |
| [`src/client/locales.ts`](src/client/locales.ts) | The `a2ui` zh/en dictionaries |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the producing tool to the conversation host and the assembly model.

- [dsh-tool-a2ui-surface](../../web/tool-a2ui-surface/README.md) — the model-facing tool that produces the durable `a2ui/surface` record.
- [ui-conversation](../ui-conversation/README.md) — the assembly host: Definition registries, Contexts, and the `conversation.chat.node` slot.
- [ui-chat](../ui-chat/README.md) — the Chat target that renders the keyed nodes and owns process folding.
- [Generated durable-event catalog](../../../docs/persistence-catalog.md#a2uisurface--log-only) — the logged record and its replay contract.
- [Conversation subsystem](../../../docs/subsystems/conversation.md) — how a business-owned feature registers a Conversation node.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that renders durable A2UI surface records as interactive Chat nodes without changing model context.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the renderer can draw and how far user work survives; they are current package constraints, not a task backlog.

- **Each opening is its own transcript row** — a deliberately reused `surfaceId` opens a fresh node instead of merging or replacing the earlier page, and every row stays visible and submittable after later pages arrive.
- **In-progress user edits are not durable** — form values and canvas arrangements live in panel state; a reload or renderer remount replays the model-authored page from the log and discards unsent edits.
- **Submission is a plain composer message** — the payload leaves as JSON text through the ordinary input machine, and the panel refuses to submit while the machine is busy; there is no structured submission channel outside the message loop.
- **Only the Chat target renders surfaces** — the Definition targets `chat`; the trajectory and other conversation views show no surface node.
- **The renderer draws only the declared vocabulary** — form fields and canvas graphs render natively, but the client adds no widget kinds beyond the model-authored set.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No invariant companion is published because this package owns no runtime state that could diverge from an independent observation; the durable `a2ui/surface` event invariant lives in the Host tool package that records it.
