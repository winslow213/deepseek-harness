# Agent Note: A2UI live-result stream as a durable, replayable event

Status: implemented

English | [中文](2026-09-09-a2ui-live-result-stream.zh.md)

## Problem

An A2UI page that starts long work had no replayable live view. The `command` action already streamed output into the popup, but over a Remote polling side channel that never entered the session log, so the page could not re-render its console from replay. A `model` action that starts a background job had no channel at all: the job's output is read by the model through `job_output`, which owns the job's single consuming cursor, so a second consumer (the page's live-result pane) would steal the model's deltas. The [dynamic data sources and live results proposal](../../proposed/feature/2026-09-08-a2ui-dynamic-data-and-live-results.md) named this its second capability: a `jobs` stream projected as a bounded, idempotent `a2ui/update` event stream.

## Decision

A page-correlated run — a `command` action or a `model` action's background job — emits a durable `a2ui/update` stream, and a background job gains an independent reader so a second consumer never consumes the model's cursor.

- **The event.** `SessionEventMap` gains `a2ui/update` with payload `{ surfaceId, phase: 'started' | 'delta' | 'finished' | 'aborted', seq, delta?, totalBytes? }`. It is log-only (the model never reads it), so it carries no surface metadata and is a plain event vocabulary addition — no `SESSION_FORMAT_VERSION` bump, only the persistence-catalog known-type set. Each `delta` carries only the text since the previous event; `totalBytes` is cumulative for the throughput label.
- **Command actions.** `ctx.a2uiRun` runs a `command` action in the session's mounted workspace (`session.header.cwd` as workdir) and appends one `a2ui/update` per consumed read, plus the terminal settle. The `a2uiRun.start` Remote request gains `sessionId`+`surfaceId`, and the controller resolves the owning agent to build the session adapter, refusing offline agents.
- **Independent readers.** `ShellProcess.createOutputReader()` returns a non-consuming reader with its own cursor; bash-local and pwsh-local implement it over their per-reader offsets. `JobHooks.createOutputReader?()` and `JobRegistry.openOutputReader(id, caller)` expose it to a second consumer, throwing for a final-output producer that offers none.
- **Model actions.** The model explicitly binds a job to a surface through the new `a2ui_attach_output(surfaceId, jobId)` tool. `ctx.a2uiLive` then opens an independent reader, polls it, and emits the same `a2ui/update` stream until the job settles (`killed` → `aborted`, otherwise `finished`). The model's `job_output` reads keep their own cursor.

## Alternatives considered

**Push the live view over the Remote side channel only.** Rejected: the `command` action already did this, and it is not reconstructable from the session log — the repo's model-visible ⟺ logged rule and the replay contract make a non-logged side channel a reconstructability hole. The durable event is what lets replay re-render the same console.

**Derive the live view from the model's `job_output` reads.** Rejected: `job_output` owns the job's single consuming cursor; a pane that "eavesdrops" on those reads shows nothing while the model is not reading, and every read the pane makes steals a delta from the model.

**Automatic surface association.** Rejected in favor of explicit binding: an "active surface" heuristic (the model action whose turn started the job) needs a host-side association state machine and a job-start signal the jobs seam does not currently expose. Explicit `a2ui_attach_output` is one tool call the model already has the information to make, and it keeps the binding unambiguous and replayable.

## Consequences

A `command` action and a `model`-action background job both project a durable, replayable live stream into the popup. The `model`-action path depends on the model calling `a2ui_attach_output` after starting the job; if it omits the call, the page shows no live pane (the job still runs and remains readable through `job_output`). The independent reader reads from byte offset 0 when opened, so output produced before attach is delivered in the first delta. Streams settle on job terminal status and clear their poll timer; a teardown-removed job or a reader failure settles `aborted`.
