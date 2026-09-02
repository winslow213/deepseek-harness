# Agent Note: Model-authored A2UI form pages

Status: implemented

English | [中文](2026-08-20-a2ui-model-authored-form-pages.zh.md)

## Problem

Open-ended questions make the model guess what the user means. An agent that collects structured input repeatedly has no way to present a fillable form, and a model-authored UI cannot persist: the page the model draws exists only while its process runs, so a refresh or a later Session open loses it. The Web Client already assembles business-owned Conversation Nodes from durable Session events, so a model-authored page needs a producer that writes the page into the calling Session, a durable record that survives replay, and a client renderer that draws it as a native form.

## Decision

`dsh-tool-a2ui-surface` registers the `a2ui_surface` tool on the host tool registry. The tool takes a declarative `page` object (`title`, optional `description`, `submitLabel`, `instruction`, and a non-empty `fields` array of `text`, `textarea`, `select`, `number`, or `checkbox` controls) and an optional `surfaceId`. The registry schema enforces the field enum and rejects unknown keys, so the logged page always equals what the model believes it wrote. The tool then validates value constraints the schema cannot express — non-empty trimmed title, unique non-empty trimmed field names, and at least one option per `select` — and appends one durable `a2ui/surface` event `{ surfaceId, page }` to the calling agent's Session. It rejects a caller without an owning agent Session.

The `allowUpdate` config is required with no default and gates replacement. `false` (the base-bundle and standard-preset choice) mints a fresh `surfaceId` per call and rejects any explicit `surfaceId`; `true` (the 天问星 preset choice) lets the model pass a stable `surfaceId` to replace an existing surface, so a flow can refine a page after the user submits. A package-owned invariant rejects invalid or un-trimmed surface records on both cold load and live append, because the browser renderer trusts the log shape: a record that cannot render fails loud instead of degrading the UI silently.

The user submission never writes a new durable node. The panel serializes the collected values into a `user/message` carrying `{"a2uiSubmit": {"surfaceId", "values"}}` and sends it through the ordinary input machine, so the model receives the values as an ordinary message keyed by the same `surfaceId`.

`dsh-client-ui-a2ui` registers one `a2ui-surface` Conversation Definition and one keyed Chat renderer. The definition matches every `a2ui/surface` event as a standalone `start` (there is no update state after the page opens), keys each node by `surfaceId#seq` so a deliberately reused `surfaceId` opens a fresh row instead of colliding, and anchors the node at the opening event. `A2uiPanel` renders the page natively as a form: text, textarea, select, number, and checkbox controls, required-field validation, and a busy guard that refuses submission while the input machine is adjudicating, claimed, or submitting. Localized copy lives in the `a2ui` namespace (zh + en).

Assembly mounts both halves on the shipped surfaces: the base bundle and the `standard` agent preset register the tool (open-only), the `web-app` bundle registers the `ui-a2ui` client plugin and disables the base tool row so each session mounts it through its preset, and the 天问星 preset enables updates. The tool and persistence catalogs are regenerated from the shipped schemas and the extended `SessionEventMap`.

## Verification

Package tests drive the real plugin and a real Session: schema shape, trimmed storage, fresh minting, explicit replacement, open-only rejection, malformed page rejection, non-agent rejection, and HMR disposal. Client tests cover the Conversation projection (standalone start rows, no update state) and the panel (field rendering, required validation, busy refusal, submission payload). The repo gates pass: typecheck, the package tests, `verify-cordis-config`, and the regenerated tool and persistence catalogs.

## Alternatives considered

**Return the page to the client through a dedicated wire channel.** Rejected because the Session log already provides persistence, live delivery, replay, and gap repair; a second transport would duplicate the same facts and create a second lifecycle owner.

**Persist a full UI tree and let the model edit it imperatively.** Rejected because the shipped record is the minimal declarative page the renderer can draw; an imperative edit protocol would need its own durability and replay rules without adding user-visible capability.

**Render the page inside the existing tool card.** Rejected because `ui-tool` and the tool definition own that row's presentation; an interactive form is an independent business lifecycle and needs its own keyed node.

**Send the submission as a tool result.** Rejected because the user acts after the tool call has returned; the submission is a new user turn and arrives as an ordinary `user/message` that the model already understands.

## Consequences

Model-authored forms now survive refresh and recovery in the same log as the conversation and render natively in the Web Client, replacing open-ended prompting for structured input. The change adds one tool, one durable event, one client renderer, and one package-owned invariant; deployments choose replacement policy per preset. The page vocabulary is deliberately small (five field kinds), giving up rich layout, validation rules, and scripted interactivity in favor of a shape the browser can trust and replay.
