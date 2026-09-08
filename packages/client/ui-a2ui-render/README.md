---
description: "The zero-cordis React renderer for model-authored A2UI pages: the form and canvas panels, the standalone popup mount, and the popup wire protocol, consumed by the web frontend's dedicated /a2ui.html window."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-a2ui-render

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-a2ui-render` is the zero-cordis React library that draws model-authored A2UI pages. It owns the `form` and `canvas` panels, the field-logic expression evaluator, the standalone popup mount (`renderA2uiPopup`), and the popup wire protocol. It is consumed by the web frontend's dedicated `/a2ui.html` window: the `ui-a2ui` plugin no longer renders pages inline, but shows a launcher card whose button opens this popup. Keeping the renderer free of the client Context merges is what lets the static assembly bundle it without dragging the session shell in.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Import `renderA2uiPopup` and mount one page into a popup window's DOM node:

```ts
import { renderA2uiPopup } from '@deepseek-ai/dsh-client-ui-a2ui-render'

renderA2uiPopup(root, { surfaceId, page })
```

The mount reads the active locale from `localStorage` (`dsh.locale`) and posts submissions and `model`-mode actions back to the opener via `window.opener.postMessage`. `local` actions resolve entirely in the browser and never post a message.

### The wire protocol

- Opener → popup: `{ type: 'a2ui/init', surfaceId, page }`, `{ type: 'a2ui/ack' }`.
- Popup → opener: `{ type: 'a2ui/ready' }`, `{ type: 'a2ui/submit', surfaceId, payload }`, `{ type: 'a2ui/action', surfaceId, action, values }`.

The opener (`ui-a2ui`'s launcher) serializes submissions and actions into the model's `a2uiSubmit` / `a2uiAction` messages.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The panels accept a channel-agnostic props shape (`page`, `surfaceId`, `t`, `busy`, `onSubmit`, `onAction`) rather than the chat slot props. `A2uiFormPanel` owns field values and evaluates `visibleWhen`/`validateWhen`/`compute` through the restricted, no-`eval` expression evaluator; `A2uiCanvasPanel` owns the React Flow node graph. The shared `A2uiChrome` draws the title, description, instruction, error, local-result, action buttons, and submit control for both.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a zero-cordis A2UI renderer library that draws pages and posts collected values to the opener, which owns model serialization.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The renderer is a component library, not a plugin; mounting and locale registration stay with `ui-a2ui`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
