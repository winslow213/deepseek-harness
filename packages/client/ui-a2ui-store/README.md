---
description: "The dsh web client sidebar panel for saved A2UI tools: how it lists pages exported by a2ui_export from the local tool store and re-opens one into the current session over the a2uiStore Remote."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-a2ui-store

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-a2ui-store` is the browser plugin that adds a sidebar footer entry for saved A2UI tools. Clicking the entry opens a popover listing every page previously saved by the `a2ui_export` tool into the harness home's `a2ui-tools` directory; clicking a tool re-opens its page into the current session, and the trash control removes the saved file. The list and each action travel over the `a2uiStore` Typert Remote to the host-side `dsh-tool-a2ui-store` controller, so the browser never touches the filesystem. Re-opening a tool appends a fresh `a2ui/surface` record to the live session, which the existing `ui-a2ui` projection renders as an interactive Chat node. Copy lives in the `a2uiStore` locale namespace (zh and en); the plugin takes no configuration.

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

When this plugin is mounted, the sidebar footer gains an A2UI-tools entry. Open it to see every saved tool; click a tool's title to open that page in the current session, or its trash control to remove the saved file. The popover shows a hint when no session is open or when a load or open fails.

### Assembly

The shipped web-app bundle inserts the plugin row into its browser roster, after `ui-a2ui`:

```yaml
- id: ui-a2ui-store
  name: '@deepseek-ai/dsh-client-ui-a2ui-store'
```

The row carries no configuration. The browser plugin injects `slots`, `locale`, `remote`, and `remote.a2uiStore`; the `remote.a2uiStore` namespace comes from the `dsh-api-remotes` client assembly, which mounts the `dsh-tool-a2ui-store` Remote contribution. The node half (`@deepseek-ai/dsh-client-ui-a2ui-store` root entry) stays inert because the whole feature is browser-side, mirroring `ui-a2ui`.

### Re-opening a saved tool

Opening a tool calls `a2uiStore.open(sessionId, name)`. The host controller reads the saved page JSON and appends a new `a2ui/surface` event to the addressed session; `ui-a2ui` then renders it in the transcript exactly as if the model had just emitted it, so the page is interactive and its submission returns to the model.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers one `sidebar.footer.action` list entry (`id: a2ui-store`) with an inject face of three verbs. `listTools` calls `remote.a2uiStore.list()` and unwraps the `RemoteResult` to `{ tools }`; `openTool(sessionId, name)` and `removeTool(name)` unwrap their results the same way, throwing on a Remote failure so the panel's error state catches it. The panel component reads the current session through the global `useSessions` hook (`state.current`), keeps the popover in local `closed | loading | ready | error` phase state, and closes on an outside pointer via `useDismissOnOutsidePointer`. The remove control updates the local list after a successful remove. Copy lives in the `a2uiStore` locale namespace with complete zh/en dictionaries, and the entry rides the standard slot locale seat.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- `packages/web/tool-a2ui-store` — the host-side store: the `a2ui_export` tool, the `a2uiStore` capability, and the `a2uiStore` Remote controller (`list`/`open`/`remove`).
- `packages/client/ui-a2ui` — the projection that renders a re-opened page as an interactive Chat node.
- `packages/api/remotes` — the client assembly that mounts the `a2uiStore` Remote contribution.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer whose sidebar panel lists and removes saved A2UI tools without changing model context.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The popover lists tools by their saved file name; there is no rename or preview beyond the page title.
- Removing a tool deletes the saved file immediately; there is no confirmation.
- The store directory is the harness home's `a2ui-tools`; a deployment cannot yet point the panel at a different directory.

-----

<a id="dev-note"></a>
### Dev Note

The panel is entirely browser-side; its host twin is `dsh-tool-a2ui-store`. Keeping the Remote's wire types in `dsh-tool-a2ui-store/types` (a client-safe, value-free module) is what lets `dsh-api-remotes` re-export them for the browser without dragging host-only code across the boundary.
