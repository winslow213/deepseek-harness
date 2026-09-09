---
description: "The A2UI dynamic data-source capability: how a deployment composes a provider that resolves a stable source name into a select field's options, and the Remote namespace the browser reaches."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-a2ui-data

English | [中文](README.zh.md)

## Summary

`dsh-tool-a2ui-data` is the capability seam behind an A2UI `select` field whose options come from a live source instead of the model's authored list. A field declares a stable `source` name; the browser launcher asks the host through the `ctx.remote.a2uiData` namespace, the composed provider (`ctx.a2uiData`) resolves the name, and the options return to the popup. The model authors only the source name, never the data — the source is a deployment-owned, validated whitelist, so a page cannot reach arbitrary host execution through the data-source channel.

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

This package is a library, not a plugin: it declares the `ctx.a2uiData` provider contract and the `A2uiDataController` Remote service, but a composition must also mount a provider that supplies `ctx.a2uiData`. The shipped provider is [`dsh-tool-a2ui-data-bash`](../tool-a2ui-data-bash/README.md); a deployment composes one provider beside the surface tool.

### The provider contract

A provider implements two methods:

| Member | Meaning |
|---|---|
| `has(source)` | Whether the provider registers the named source; anything else is refused before any command runs. |
| `resolve(source, args)` | Resolve the source into `{ items: [{ label, value }] }`; `args` is the collected field values the provider may reference. |

The Remote namespace (`ctx.remote.a2uiData.resolve`) rejects an unknown source with `a2ui-data/unknown-source`; the browser launcher forwards a successful resolve as `a2ui/data` and a failure as `a2ui/data-failed` to the popup.

### The `./types` subpath

The wire request/response and the resolved-items contract are published as the browser-safe `./types` subpath (types only), so the browser half reads the same declarations the Host emits.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/data.ts`](src/data.ts) declares the `A2uiDataProvider` interface every consumer reads from `ctx.a2uiData`. [`src/remote.ts`](src/remote.ts) declares the `a2uiData` Remote namespace owner (`A2uiDataController`) whose single `resolve` method validates the source against the provider's whitelist and returns its items. [`src/types.ts`](src/types.ts) carries the browser-safe wire types. The package carries no `apply` of its own: the provider plugin supplies `ctx.a2uiData` and mounts `A2uiDataController` beside it, exactly as `dsh-tool-a2ui-store` mounts its controllers.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Re-exports the provider contract, wire types, and Remote controller |
| [`src/data.ts`](src/data.ts) | The `A2uiDataProvider` capability contract |
| [`src/remote.ts`](src/remote.ts) | The `a2uiData` Remote namespace owner (`resolve`) |
| [`src/types.ts`](src/types.ts) | Client-safe wire request/response and the resolved-items contract |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-tool-a2ui-data-bash](../tool-a2ui-data-bash/README.md) — the shipped bash-backed provider.
- [dsh-tool-a2ui-surface](../tool-a2ui-surface/README.md) — the model-facing tool whose page declares the `source` field.
- [dsh-client-ui-a2ui](../../client/ui-a2ui/README.md) — the browser launcher that reaches `ctx.remote.a2uiData`.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package is a host capability and Remote namespace with no model-facing tool; the model sees only the `source` field description on `a2ui_surface`'s schema.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The provider is the composition's responsibility** — this package declares the seam but ships no implementation; a deployment that composes no provider has no resolvable source, and the browser launcher reports each such field as failed.
- **Resolve results are not yet durable** — the options travel back through the Remote return and are not recorded as a session event, so a page re-request runs the provider again rather than replaying a logged result; the durable `a2ui/data` event is deferred.
- **Source arguments are unused on first mount** — the popup requests a source with empty arguments when the page opens; a source that depends on another field's value needs a later refresh mechanism.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The dynamic-data-source design (the `source` field, the provider seam, and the deferred durable `a2ui/data` event) is recorded in the [A2UI dynamic data sources proposal](../../../.agents/notes/proposed/feature/2026-09-08-a2ui-dynamic-data-and-live-results.md).

</details>

**Runtime invariant:** No companion is published. The package declares one provider contract and one Remote namespace; the controller's HMR-safety and the source-validation behavior are pinned by its unit tests, with no independent runtime state to diverge.
