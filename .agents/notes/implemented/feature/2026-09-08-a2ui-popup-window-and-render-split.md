# Agent Note: A2UI popup window and zero-cordis render split

Status: implemented

English | [中文](2026-09-08-a2ui-popup-window-and-render-split.zh.md)

## Problem

A model-authored A2UI page rendered inline as a Conversation Node inside the chat transcript. Inline rendering bound the page to the chat column: the form or canvas shared the narrow message width, could not stay open while the user scrolled or switched sessions, and left no dedicated surface for reuse. The inline renderer also lived inside the `ui-a2ui` plugin, so the web frontend's static assembly (which builds the dedicated popup entry `/a2ui.html`) could not bundle it without dragging in the client Context merges that plugin owns.

## Decision

A2UI pages render in a dedicated popup window instead of inline, and the renderer moves into a zero-cordis package so both the plugin and the static assembly can consume it.

- **Popup windowing.** `A2uiLauncher` replaces the inline panel: a compact card whose button calls `window.open('/a2ui.html', 'a2ui-<surfaceId>', …)`. The popup and opener share a typed postMessage vocabulary (`a2ui/ready` → `a2ui/init` carrying `surfaceId` and `page`; `a2ui/submit` and `a2ui/action` back to the opener), and the launcher forwards submissions and model actions into `inputActions` exactly as the inline panel did.
- **Zero-cordis render split.** A new `staticLinked` package `dsh-client-ui-a2ui-render` owns the form/canvas renderers, the expression evaluator, and the standalone popup mount. `apps/web` imports it to build `/a2ui.html`; `ui-a2ui` only type-imports its wire types, so the static assembly never pulls the plugin's client Context merges.
- **Open inside the click gesture.** `A2uiStorePanel` opens the named popup window directly inside its click handler, then the chat launcher that the re-render projects adopts the same-named window (a same-name `window.open` returns the existing reference without user activation) and completes the handshake. This keeps the browser from blocking the popup.
- **Static theme styles.** The popup has no `ui-theme` plugin to inject the design-token sheets at runtime, so the popup entry imports `base.css` / `design-platform.css` / `corner-shape.css` / `scrollbar.css` statically; the `--dsw-alias-*` and `--dsw-font-*` variables the render components read resolve from those sheets.
- **`a2uiStore/remove` renamed to `a2uiStore/delete`.** `remove` collides with a reserved member of the Cordis Remote namespace service, which aborted the entire `api-remotes` plugin load; the client Remote method and its wire request/value types now use `delete`.

## Alternatives considered

**Keep inline rendering.** Rejected: the page had to be usable in its own window and reusable from the sidebar, which the chat column cannot provide.

**Run the `ui-theme` plugin inside the popup.** Rejected: the popup is a minimal surface with no session, module table, or host connection; dragging in a full plugin lifecycle to inject CSS would defeat its leanness, so the static CSS import is the whole answer.

**Send a single `a2ui/ready` from the popup.** Rejected: the sidebar can open the window before the chat launcher has mounted its message listener, so a lone `ready` would be dropped and the handshake stall. The popup re-announces on an interval until it receives `a2ui/init`.

## Consequences

The popup is a separate document, so any new `--dsw-*` variable a render component reads must also resolve from the statically imported theme sheets or the popup silently degrades. Popup blocking is only avoided by opening inside a user gesture; the launcher button and its "open directly" link remain the fallback. The render package is zero-cordis: it must never import a client Context merge, or the static assembly boundary breaks.
