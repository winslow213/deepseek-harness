# Agent Note: A2UI submissions log as collapsed context notices

Status: implemented

English | [中文](2026-09-09-a2ui-submission-notice-context.zh.md)

## Problem

An A2UI action or form submission entered the conversation through the ordinary input machine, so the chat rendered it as a full user prompt bubble: the raw JSON (`{"a2uiAction": { ... }}` with its `surfaceId`, `actionId`, `instruction`, and `values`) sat in the transcript beside the interactive page. The payload is a machine-to-model envelope, not a human message, so showing it as a user bubble clutters the conversation with text the user never typed.

## Decision

A2UI actions and form submissions log as a `user/message` with a plugin `notice` source instead of a user source, so the chat renders a collapsed one-line context row while the model still receives the full payload.

- **Host prompt context.** `SessionPromptRequest` gains an optional `context: { plugin, form: 'notice', summary }`. When present, `commands.prompt` stamps the message source as `{ kind: 'plugin', plugin, form: 'notice', summary }` instead of `{ kind: 'user', rpcId }`; the model-visible content is unchanged, so the model-facing contract (`model-visible ⟺ logged`) holds.
- **Client notice submitter.** The `ui-a2ui` browser plugin builds a `submitNotice` over `ctx.remote.session.prompt` with that context; the launcher calls it for `a2ui/submit` (summary = the page title) and `a2ui/action` (summary = the action `instruction`, falling back to `tool` then `id`). A rejected admission rejects the promise; the launcher fires and forgets it and still acks the popup.
- **Summary is a bounded one-line account.** The notice summary is the existing collapsed-row contract (`CONTEXT_SUMMARY_MAX_CHARS = 120`); the launcher truncates longer titles/instructions before sending.

## Alternatives considered

**Render a full prompt bubble but strip the JSON.** Present a friendly "submitted" line while keeping the raw envelope out of view. Rejected: the durable log must carry the exact model-facing text, and the presentation cannot diverge from what is logged without a new hidden-visibility concept that the conversation contract does not have.

**A dedicated structured submission channel.** Add a wire event distinct from `user/message` carrying the payload typed. Rejected: the model consumes A2UI submissions as ordinary user-role messages, so a separate channel would still have to join the same model input and would duplicate the existing prompt path for no model-visible gain.

**Mark the prompt `hidden` in the client.** Add a hidden visibility to the conversation node contract. Rejected: no such concept exists, and inventing one would affect every node renderer; the notice form is the repository's existing way to collapse non-user content.

## Consequences

A2UI submissions no longer render as user bubbles; the transcript shows a collapsed `a2ui` context row with a one-line summary and the model-facing JSON only on expansion. The `session/prompt` request type gains an optional field, reflected in both SDKs through the Typert-generated client remote. Submissions bypass the composer/input machine, so there is no draft interaction, busy-phase gating, or optimistic echo for A2UI submissions — a failed admission surfaces only as a rejected promise.
