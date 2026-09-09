# Agent Note: A2UI dynamic data-source provider seam

Status: implemented

English | [中文](2026-09-09-a2ui-data-source-provider.zh.md)

## Problem

An A2UI `select` field's options had two authors: the model (static `options`) or a model-authored `script` action (`optionsFrom`). Neither can serve a live, deployment-owned source — a device list from `hdc list targets`, a directory listing, a metric read. Authoring that data into the page couples the model to facts it cannot know, and a `script` action lets the model supply executable logic rather than naming a trusted source. The [dynamic data sources proposal](../../proposed/feature/2026-09-08-a2ui-dynamic-data-and-live-results.md) named this as its first capability: a `select` field declares a stable `source`, and a host-backed provider resolves it.

## Decision

This decision partially supersedes only the data-source binding capability (proposal item 1) in [A2UI dynamic data sources and live results](../../proposed/feature/2026-09-08-a2ui-dynamic-data-and-live-results.md); that note remains active for the live result channel and scripted local actions. A `select` field declares a `source` name resolved by a new capability seam, with the shipped bash-backed provider as its reference implementation.

- **`source` field.** `A2uiField` gains a `source` string, canonicalized as mutually exclusive with static `options` and `optionsFrom`, and only valid on a `select` field. The model authors the name, never the data.
- **Provider seam.** A new package `dsh-tool-a2ui-data` declares the `A2uiDataProvider` contract (`has(source)` / `resolve(source, args) → { items }`) and the `a2uiData` Remote namespace owner. The provider is a composition choice; `dsh-tool-a2ui-data-bash` is the shipped implementation over `ctx.shell`.
- **Bash provider.** `dsh-tool-a2ui-data-bash` resolves each whitelisted source by running one operator-configured command through the composed shell service. The command may use `{fieldName}` placeholders filled with POSIX single-quoted words, so a collected value can never splice command syntax; stdout is parsed as a JSON array, a `{ items: [...] }` envelope, or trimmed lines.
- **Client flow.** The popup requests each `source` on mount (`a2ui/data-request`); the launcher resolves it through `ctx.remote.a2uiData.resolve` and posts the options back (`a2ui/data`) or the failure (`a2ui/data-failed`). A failed source degrades to an empty select rather than failing the page.

## Alternatives considered

**Reuse `optionsFrom` script actions.** A model-authored script could already populate options. Rejected: `optionsFrom` lets the model supply executable logic, not name a trusted source; a deployment-owned whitelist needs an operator-configured command the model cannot author.

**Durable `a2ui/data` event for replay.** The proposal recorded each resolve as a session event so replay re-renders identical options without re-running the provider. Deferred: the options list is not model-visible (only the selected value enters the submit payload), and `Session.append` cannot mark an event `ignorable`, so the durable event is left out of this change and the popup re-requests on each mount.

## Consequences

A page can now pull options from a deployment-controlled source without the model authoring the data or executable logic. The options travel through the Remote return rather than a session event, so a re-request runs the provider again; source arguments are empty on first mount, leaving field-dependent sources to a later refresh mechanism. The bash provider is the reference implementation of the seam, and a deployment may substitute its own provider beside the surface tool.
