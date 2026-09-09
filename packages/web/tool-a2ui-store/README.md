---
description: "The A2UI tool store: how the model saves an authored page as a distributable JSON file under the harness home, and how deployments re-import saved tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-a2ui-store

English | [中文](README.zh.md)

## Summary

With `dsh-tool-a2ui-store`, a page the model authored with `a2ui_surface` can be saved as a standalone file and shared: the `a2ui_export` tool and the `ctx.a2uiStore` capability persist the canonical page definition — its declarative DSL, field logic (`visibleWhen`/`validateWhen`/`compute`), and `actions` — as one JSON document per tool under `<harness home>/a2ui-tools/`. Each write is an atomic replace, and a malformed document is skipped on read rather than hiding the rest. The store is the distribution boundary: a saved file can be copied between deployments and re-imported without re-authoring the page.

The package also owns the two page-correlated execution channels: `ctx.a2uiRun` starts `command` actions on the composed shell service in the session's workspace and records their output as a durable `a2ui/update` stream, and `ctx.a2uiLive` streams a `model`-action background job into the same durable stream (via the `a2ui_attach_output` tool, which the model calls with the job id it just started).

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

The store is a thin, dependency-light filesystem layer. `store.ts` resolves the directory (explicit override wins, else `$DSH_HOME/a2ui-tools`), writes each tool with `writeFileAtomic` (temp sibling + rename, `0o600` file / `0o700` directory) so a concurrent reader always sees a complete document, and lists by name-sorted `.json` stems. A tool name must be a single safe file stem (no separators, not `.`/`..`, at most 64 chars). `index.ts` provides the capabilities on `ctx` and registers the tools. `run.ts` starts `command` actions over the shell service in the session workspace and appends their output as `a2ui/update` events; `live.ts` streams a `model`-action background job's output into the same event stream through an independent jobs reader. Both reuse `canonicalizeA2uiPage` from `dsh-tool-a2ui-surface` so saved and rendered pages are byte-identical.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `ctx.a2uiStore`/`ctx.a2uiRun`/`ctx.a2uiLive` capabilities, `a2ui_export` + `a2ui_attach_output` tool registration |
| [`src/store.ts`](src/store.ts) | Filesystem persistence: resolve/save/list/remove with atomic writes |
| [`src/run.ts`](src/run.ts) | `command`-action runner: shell quoting, workspace workdir, `a2ui/update` emission |
| [`src/live.ts`](src/live.ts) | `model`-action live-result streaming over `ctx.jobs` |
| [`src/types.ts`](src/types.ts) | Client-safe `A2uiToolRecord`, `A2uiUpdateData`, and the name-safety rule |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees two tools. `a2ui_export` carries its static description and the exact JSON schema recorded in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-a2ui-store); the description tells it to save the page it authored as a reusable tool file under the local tool store, with a short stable `name` for the saved file and a `page` in the same shape as `a2ui_surface`'s page argument. `a2ui_attach_output` takes a `surfaceId` and a `jobId` and tells it to call it after starting a background job as part of an A2UI action, so the page's live-result pane follows the job's output.

#### Token effect

Fixed description-and-schema cost on every request where the tool is visible to the agent. The `name` string and the `page` object are lightweight compared with a field-rich page tool, so this definition is cheaper than `a2ui_surface`'s schema; `a2ui_attach_output` adds only two short strings.

#### KV Cache effect

Prefix-stable while the registered definition and its visibility are unchanged; plugin lifecycle or a scoped tool restriction may invalidate reuse from the first changed schema token.

### Tool call and result

#### What the model sees

The tool call keeps the authored page JSON in history. Success renders exactly `Saved A2UI tool "<name>" to the local tool store.`; a call without an owning agent session fails with `a2ui_export requires an owning agent session`; an invalid page fails with the canonicalization error naming the violation.

#### Token effect

Authored page arguments stay in retained history until compaction and scale with the page the model wrote; the rendered result is short fixed text plus the saved name.

#### KV Cache effect

Append-only; the call and result follow the reusable request prefix and do not invalidate existing KV-cache entries.

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
