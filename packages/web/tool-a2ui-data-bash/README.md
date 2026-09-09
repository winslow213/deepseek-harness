---
description: "The bash-backed A2UI data-source provider: resolves a whitelisted source name into a select field's options by running one operator-configured command through the shell service."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-a2ui-data-bash

English | [中文](README.zh.md)

## Summary

`dsh-tool-a2ui-data-bash` is the shipped provider for the A2UI dynamic data-source capability. It supplies `ctx.a2uiData` and mounts the `a2uiData` Remote controller, resolving each whitelisted source name into a `select` field's options by running one operator-configured command through the composed `shell` service. The source → command whitelist is the deployment's explicit, validated surface: the model (through the page DSL) only ever names a `source`, never supplies a command, so a page cannot reach arbitrary host execution through the data-source channel.

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

Mount this package beside the surface tool and the data-source capability. It supplies `ctx.a2uiData` and registers the `a2uiData` Remote controller.

### Minimal configuration

```yaml
- id: tool-a2ui-data-bash
  name: '@deepseek-ai/dsh-tool-a2ui-data-bash'
  config:
    sources:
      hdc-devices:
        command: "hdc list targets"
        timeoutMs: 10000
```

| Field | Default | Meaning |
|---|---|---|
| `sources` | `{}` | Source name → `{ command, timeoutMs? }`; a page may only name a key here. |
| `sources.<name>.command` | required | The shell command producing the options; may use `{fieldName}` placeholders filled from the collected field values. |
| `sources.<name>.timeoutMs` | shell default | Run bound in milliseconds. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-a2ui-data-bash) is the exhaustive source.

### Option output

The command's stdout becomes options in three accepted shapes: a JSON array of `{label,value}` records, a JSON `{ items: [...] }` envelope, or plain lines where each non-empty trimmed line becomes one option whose label and value are the line. Invalid entries are skipped; a nonzero exit fails the resolve with the stderr detail.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) defines the whitelist schema, fills `{fieldName}` placeholders with POSIX single-quoted words (so a collected value can never splice command syntax), runs the resolved command through `ctx.shell.run` with a 1 MiB stdout cap, and parses the output into options. `BashA2uiDataProvider` implements the `ctx.a2uiData` contract; `apply` provides it and mounts `A2uiDataController`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-tool-a2ui-data](../tool-a2ui-data/README.md) — the capability contract and Remote namespace this provider implements.
- [dsh-shell](../../shell/shell/README.md) — the executor that runs each source command.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package is a host provider with no model-facing tool; it only runs the commands a deployment configured for named sources.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Sources are fixed at composition time** — the whitelist is deployment config, not model-authored; adding a source means editing cordis.yml and restarting.
- **One command per source** — a source runs a single command; sequencing or a pipeline belongs in the command string itself.
- **Placeholders only on first mount** — the popup requests a source with empty arguments, so a `{fieldName}` placeholder only resolves against values the page already holds at open time.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The bash provider is the reference implementation of the data-source seam described in the [A2UI dynamic data sources proposal](../../../.agents/notes/proposed/feature/2026-09-08-a2ui-dynamic-data-and-live-results.md).

</details>

**Runtime invariant:** No companion is published. The provider owns no runtime state beyond its whitelist; its resolve and fill behavior are pinned by unit tests.
