---
description: "The A2UI tool store: how the model saves an authored page as a distributable JSON file under the harness home, and how deployments re-import saved tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-a2ui-store

English | [中文](README.zh.md)

## Summary

With `dsh-tool-a2ui-store`, a page the model authored with `a2ui_surface` can be saved as a standalone file and shared: the `a2ui_export` tool and the `ctx.a2uiStore` capability persist the canonical page definition — its declarative DSL, field logic (`visibleWhen`/`validateWhen`/`compute`), and `actions` — as one JSON document per tool under `<harness home>/a2ui-tools/`. Each write is an atomic replace, and a malformed document is skipped on read rather than hiding the rest. The store is the distribution boundary: a saved file can be copied between deployments and re-imported without re-authoring the page.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package wherever an agent should persist the pages it authors. It registers the `a2ui_export` tool on the tools registry and provides `ctx.a2uiStore`.

### Minimal configuration

```yaml
- id: tool-a2ui-store
  name: '@deepseek-ai/dsh-tool-a2ui-store'
```

| Field | Default | Meaning |
|---|---|---|
| `dir` | `<harness home>/a2ui-tools` | The store directory; an explicit path overrides the default |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-a2ui-store) is the exhaustive source.

### The save loop

The model calls `a2ui_export` with a `name` and the same `page` shape `a2ui_surface` renders. The page is canonicalized (unknown field types and node roles are rejected) and written to `<dir>/<name>.json`; a same-named save replaces the file. `ctx.a2uiStore` exposes the same `list`/`save`/`remove` operations to host consumers, and the saved record carries the page plus an ISO `savedAt` timestamp.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The store is a thin, dependency-light filesystem layer. `store.ts` resolves the directory (explicit override wins, else `$DSH_HOME/a2ui-tools`), writes each tool with `writeFileAtomic` (temp sibling + rename, `0o600` file / `0o700` directory) so a concurrent reader always sees a complete document, and lists by name-sorted `.json` stems. A tool name must be a single safe file stem (no separators, not `.`/`..`, at most 64 chars). `index.ts` provides the capability on `ctx` and registers `a2ui_export`, which reuses `canonicalizeA2uiPage` from `dsh-tool-a2ui-surface` so the saved page is byte-identical to what the browser renderer trusts.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `ctx.a2uiStore` capability, `a2ui_export` tool registration |
| [`src/store.ts`](src/store.ts) | Filesystem persistence: resolve/save/list/remove with atomic writes |
| [`src/types.ts`](src/types.ts) | Client-safe `A2uiToolRecord` and the name-safety rule |

</details>

-----

<a id="model-experience"></a>
## Model Experience

The model sees `a2ui_export` with a `name` (a stable file stem) and a `page` (the same JSON it passes to `a2ui_surface`). Success renders ``Saved A2UI tool "<name>" to the local tool store.``; an invalid page or a non-agent caller fails with the canonicalization error. The page schema is described by the shared [A2UI page vocabulary](../../../docs/tool-catalog.md#deepseek-aidsh-tool-a2ui-surface).

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The store is host-side only** — it persists files under the harness home; exposing the list to the browser sidebar and re-rendering a saved tool client-side requires a Remote namespace and a client panel, which are not part of this package.
- **No live watch** — the list is read on demand; a file added by another process appears on the next `list()`, not by push.
- **One document per tool** — a tool is a single JSON file; the store does not version or diff documents.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
