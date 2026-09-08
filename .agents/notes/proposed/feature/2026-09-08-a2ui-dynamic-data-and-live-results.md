# Agent Note: A2UI dynamic data sources and live results

Status: proposed

English | [中文](2026-09-08-a2ui-dynamic-data-and-live-results.zh.md)

## Problem

An A2UI page is a static declaration the browser evaluates once. Field logic (`visibleWhen`/`validateWhen`/`compute`) reacts only to sibling fields within the same page, and a `model`-mode action hands collected values to the model whose tool result never comes back into the window. A team building a tool like "log capture" needs three capabilities the page cannot express today:

- **Dynamic data** — options or derived values loaded from a real source (a device list from `hdc list targets`, a directory listing, a metric read) rather than authored into the page at generation time.
- **Dynamic execution** — custom tool logic that runs after the page opens (refresh a source, watch a command, stop a running capture), not only declarative compute at field-change time.
- **Live results** — a window that shows log throughput while a long command runs, then keeps the finished transcript.

Two constraints shape any design. The popup is a minimal document with no host connection: it currently exchanges only the one-shot `ready`/`init`/`ack` handshake ([popup windowing](../../implemented/feature/2026-09-08-a2ui-popup-window-and-render-split.md)). And the repo requires that anything reaching a model request be reconstructable from the session log ([model-visible ⟺ logged](../../implemented/architecture/2026-08-10-session-log-version-mechanism.md)), so data that could ever feed a model payload must land as a durable session event, never a side channel.

## Proposal

Three separable enhancements over the existing DSL ([forms](../../implemented/feature/2026-08-20-a2ui-model-authored-form-pages.md), [field logic + actions](../../implemented/feature/2026-09-07-a2ui-field-logic-and-actions.md)), each preserving replay and the popup's leanness.

**1. Data-source bindings.** A field (initially `select`; later read-only text derived from a source) may declare `source` instead of static `options`. A `source` is a stable name resolved by a host-backed **data provider** registered beside the surface tool — for example a `bash`-based provider that runs one whitelisted read command with validated arguments (`hdc list targets`, `ls` of a configured directory). The browser requests a source through a new `a2ui/data-request` model message; the provider runs, canonicalizes, and the host appends a durable `a2ui/data` event carrying `{ surfaceId, source, kind: 'options', items }`. The popup learns the payload only when the launcher forwards the event after the page mounts, so replay re-renders the same options without re-running anything. A refresh control re-issues the request; a `cache` duration on the provider avoids hammering the host.

**2. Live result channel.** A long-running operation is a `jobs` stream. The proposal adds one session event, `a2ui/update`, with envelope payload `{ surfaceId, phase: 'started' | 'delta' | 'finished' | 'aborted', seq, delta?, totalBytes? }`, where `delta` is the bounded incremental text since the previous event (a byte offset `seq` makes replay idempotent) and `totalBytes`/timestamps let the client derive throughput. The owner agent's tool executor emits it while a page-correlated `model` action runs, reusing the existing `jobs` stream deltas (`readOutput` returns the increment since the last read) that background `bash` runs already produce. The launcher — which already tracks the popup — subscribes to the emitting events for its `surfaceId` and forwards each as an `a2ui/update` postMessage. The event carries `ignorable: true` because a build that predates it must still replay the surrounding log ([version mechanism](../../implemented/architecture/2026-08-10-session-log-version-mechanism.md)).

**3. Scripted local actions.** Custom logic beyond one expression becomes a declarative **step list** on a `local` action: `set` (assign one field), `append` (concatenate into a target), `refresh` (re-issue a data source), `stop` (terminate the correlated job). Each step is a restricted expression or a source name — the same evaluator grammar the browser already trusts, executed in order by the existing form/canvas host. Arbitrary JavaScript is explicitly out of scope: the page must never run model-authored code, only declared operations the renderer can log and reason about.

**Presentation.** The popup renders a console/log pane when a page or action carries live results: lines append as `delta` events arrive, a rate label shows `totalBytes` per elapsed time, and `stop` maps to the correlated job's kill. The pane is log-visible UI projection over the durable `a2ui/update` events; it never fabricates text the log does not contain.

## Alternatives considered

- **Let the page run arbitrary JavaScript.** Rejected: the restricted grammar exists precisely so the browser never executes arbitrary model text ([expression grammar](../../implemented/feature/2026-09-07-a2ui-field-logic-and-actions.md)); an imperative step vocabulary keeps every effect declarative, logged, and capability-gated.
- **Push results over a side socket/WebSocket.** Rejected: the "model-visible ⟺ logged" rule and the replay contract make a non-logged side channel a reconstructability hole. Every payload the window shows travels as a session event and is forwarded by the launcher.
- **Have the popup poll the host itself.** Rejected: the popup owns no host connection by design ([popup windowing](../../implemented/feature/2026-09-08-a2ui-popup-window-and-render-split.md)); the opener is its only channel, so all updates flow opener → launcher → popup.
- **Reuse the chat jobs UI instead of projecting into the popup.** Deferred: job list/status already exists in-session, but a tool's log view belongs in the tool's window; the chat surface does not carry per-surface live panes.

## Acceptance criteria

- A `source` on a `select` yields live options after one `a2ui/data-request` round trip with no model-authored option list; replay of the session re-renders identical options.
- A long-running `model` action produces bounded `a2ui/update` deltas with monotonic `seq`; the popup renders them incrementally with a byte-rate derived from `totalBytes` and event timestamps; `stop` terminates the correlated job and a final `aborted`/`finished` event settles the pane.
- A `local` action step list executes its declared steps in order and only those; unknown steps or sources fail loud at schema validation, never at runtime halfway through a page.
- Old session logs replay on a new build and new logs on an old build: the new events carry `ignorable: true` and existing pages without `source`/`update` fields render unchanged.
- Both SDKs' loop projections and the session log version gate are updated with the new event kinds in the same change.

## Risks

- **Event volume.** A log storm could flood the log. Each delta is size-capped, the provider is whitelist-and-cache-bound, and overflow spills to the existing spill-path mechanism rather than growing the transcript unboundedly.
- **Throughput accuracy.** Rate is derived client-side from event timestamps; a bursty host or throttled postMessage makes it an estimate. Label it as approximate rather than promising byte-exact telemetry.
- **SDK and format ripple.** New `SessionEventMap` members and their expected outputs must land in the TypeScript and Python SDKs with the events ([both SDKs project the loop](../../implemented/architecture/2026-08-10-session-log-version-mechanism.md)); a structural format change also re-checks whether `SESSION_FORMAT_VERSION` must bump.
- **Scope creep toward a terminal.** The pane is a bounded log view, not a terminal emulator; interactive/proc-like shells stay out of the A2UI surface.
