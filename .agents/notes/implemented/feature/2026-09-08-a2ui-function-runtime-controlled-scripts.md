# Agent Note: A2UI unified function runtime and controlled scripts

Status: implemented

English | [中文](2026-09-08-a2ui-function-runtime-controlled-scripts.zh.md)

## Problem

A2UI pages had three mutually exclusive button semantics — `local` (show an expression text), `model` (route to the agent), and `command` (run a host shell command into a console) — wired directly into the renderer's `if/else`. There was no common notion of "an executable function on this page", no single place that folded every execution outcome into the page state, and no way to run small data-fetching or reshaping programs (`script`) in a controlled way: the model could only declare expressions and name tools or commands, never author a program that combines steps. Each new execution kind meant touching the renderer, the popup host, and the wire protocol separately.

## Decision

A2UI becomes an executable-component runtime with three orthogonal layers. A follow-up adds two render-driving features on top: an action's completion can **write back** into declared form fields (`write: [{field, from}]`, resolved by dotted selector), and a `select` field can declare `optionsFrom` naming a `script` action whose completion (a `[{label,value}]` array or `{items}` wrapper) populates the field's live options on open and on every re-run.

- **Unified invocation routing** (`a2ui-runtime.ts`, zero-cordis). `invokeAction(action, values, surfaceId, evaluate, localDone)` resolves one click into exactly one invocation: an `expr` result computed in the browser, a `command` message to run a host shell command, a `script` message to run a host program, or a `model` message to the agent. The renderer no longer branches on execution mode; each backend is a case in this pure function.
- **One popup state machine** (`reducePopupState`). Every opener reply — ack, run started/chunk/done/failed, stop, script result/failure — folds into one `A2uiPopupState` (busy, the command console's `A2uiRunState`, the local result, the script result/error). The standalone popup host is a thin `useReducer` over this projection; component `useState`-scatter is gone.
- **Controlled `script` execution** (`tool-a2ui-store/script.ts`). A new `execution: "script"` action carries an async `program` body and a `binds` grant list. The program runs on the composed code runtime (`ctx.codeRuntime`, the worker-thread backend in the web profile) — never in the browser, never in the host process — with the runtime's wall-clock/output caps and abort semantics. The program may call only the granted `a2ui.*` members, each a host helper behind an existing capability:
  - `fetch` — one `http(s)://` request through the harness web service (`ctx.web.fetch`, the base bundle's http provider); the URL scheme is validated before any call, and the JSON summary (url, status, content kind/text, truncated) crosses the code-runtime boundary.
  - `text` — a deterministic pure reshape helper (uppercase).
  The completion value and logs cross the runtime's lossless-JSON boundary and become the action result, shown in the popup.

The wire protocol (`a2ui-wire.ts`) and the launcher bridge carry the new kinds; the Remote namespace `a2uiRun` grows `runScript`; `ctx.a2uiRunScript` resolves the code runtime and web service lazily so the store plugin mounts in compositions that lack either.

## Alternatives considered

**Run scripts in the browser.** Rejected: the browser cannot make the cross-origin fetches a data-gathering script needs, and the repository's invariant that the browser never executes arbitrary model-authored code is why the restricted expression grammar exists. A script is *program data* executed on the controlled code runtime, never source the page evaluates.

**Expose every host capability to scripts.** Rejected: a script gets only the `binds` it declares, each mapping to one helper behind one owned capability, so the attack surface is the declared grant list, not the whole context. Unknown grants fail canonicalization.

**Give `script` its own wire/streaming machinery.** Rejected: a script is a single request/response (one completion value), not a long stream like `command`, so it reuses the ordinary Remote round trip and the ack lifecycle instead of the command-run chunk channel.

## Consequences

A new execution kind is now a case in `invokeAction`, a message pair in the wire protocol, a state transition in `reducePopupState`, and a host backend — each independently unit-tested. The full affected suites pass (152). A script's `fetch` inherits the web capability's provider selection and policy (what a deployment configures for the model's `web_fetch` tool is what an A2UI page can reach), and a deployment that mounts no web service fails a granted `fetch` with a clear message at run start rather than degrading silently. The controlled-code-runtime dependency means a profile must mount `ctx.codeRuntime` (the worker-thread provider in web-app) before script actions can run; `ctx.a2uiRunScript` still resolves lazily so the store plugin loads elsewhere. Binding calls are async and must be awaited in the program — an un-awaited call leaves a Promise in the completion value and the run fails the lossless-JSON boundary (the worker names the failure).
