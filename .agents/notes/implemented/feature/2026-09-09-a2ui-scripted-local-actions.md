# Agent Note: A2UI scripted local actions

Status: implemented

English | [中文](2026-09-09-a2ui-scripted-local-actions.zh.md)

## Problem

A `local` A2UI action could run only one expression and show its text. A tool page that must perform several deterministic operations after a click — assign one field, concatenate onto another, reload a data source, stop the running capture — had no way to express them without either a model round-trip (a `model` action) or a host round-trip (a `command`/`script` action). The [dynamic data sources and live results proposal](../../proposed/feature/2026-09-08-a2ui-dynamic-data-and-live-results.md) named this its third capability: a declarative step list on a `local` action, executed in order by the browser's existing expression grammar, never arbitrary model text.

## Decision

This decision supersedes the scripted-local-actions capability (proposal item 3) in [A2UI dynamic data sources and live results](../../proposed/feature/2026-09-08-a2ui-dynamic-data-and-live-results.md); that note remains active for nothing further — items 1 and 2 were implemented separately. A `local` action carries an ordered `steps` list of four restricted operations.

- **The step vocabulary.** `A2uiStep` is a closed union: `set` (assign a field an expression result), `append` (concatenate an expression result onto a field's current value), `refresh` (re-issue one `select` field's `source`), and `stop` (terminate the page's correlated running job). `set`/`append` carry a `field` and a `value` expression; `refresh` carries a `source` name; `stop` takes no argument.
- **Validation fails loud.** `canonicalizeA2uiPage` rejects an unknown step kind, a `set`/`append` whose field is not an identifier or whose `value` is empty, an empty `refresh` source, and — as a cross-reference after the field list is canonicalized — a `set`/`append` naming a field the page does not declare or a `refresh` naming a source no `select` field declares. A canvas page (no fields, no sources) accepts only `stop`.
- **Ordered resolution.** `invokeAction` resolves the step list in declaration order against a working value map, so a later step sees an earlier step's write. `set`/`append` collapse to the field's final value (an `append` already concatenated); `refresh`/`stop` pass through as opener intents. The `result` expression still shows as the action's text.
- **Browser execution.** The standalone popup host performs the resolved steps: field writes become one batch patch back into the form panel, `refresh` re-posts `a2ui/data-request`, and `stop` posts a new `a2ui/stop` message carrying the active command `runId`. The launcher forwards `a2ui/stop` to the run bridge (`stopRun`).
- **Stop stays clickable.** The chrome disables every action button while a submission/run is busy, which would block a `stop` step from terminating the very run that makes the page busy. A `local` action carrying a `stop` step is exempted from the busy-disable, so the user can always halt the correlated job.

## Alternatives considered

**Run the steps on the host.** Rejected: `set`/`append` mutate browser-side form state the host does not hold, and the proposal specifies the browser's existing evaluator grammar so no host round-trip is needed for pure field logic.

**Let a step run arbitrary JavaScript.** Rejected: the restricted grammar exists precisely so the browser never executes arbitrary model text; the four declared operations keep every effect declarative, logged, and capability-gated.

**Reuse `optionsFrom` script actions for `refresh`.** Rejected: `refresh` names a trusted `source`, not executable logic; the data-source provider already owns source resolution, so a `refresh` step re-issues that same `a2ui/data-request` round-trip.

## Consequences

A `local` action can now express a deterministic multi-step operation without any model or host round-trip except where one is genuinely needed (`refresh` reloads a source, `stop` kills the run). `stop` currently terminates only a `command` action's run; stopping a `model` action's background job needs a host-side live stop (the launcher knows the surface, not the job id) and is deferred. Invalid step references fail at canonicalization, so a malformed page never reaches the runtime.
