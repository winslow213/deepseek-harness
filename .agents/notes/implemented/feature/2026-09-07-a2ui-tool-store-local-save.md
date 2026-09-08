# Agent Note: A2UI tool store for local save and distribution

Status: implemented

English | [中文](2026-09-07-a2ui-tool-store-local-save.zh.md)

## Problem

A model-authored A2UI page existed only as a durable session record: the DSL, the field logic (`visibleWhen`/`validateWhen`/`compute`), and the `actions` a model generated were trapped inside one session log. A team could not save a page as a file, share it with another member or deployment, or re-import it without re-authoring — there was no distribution boundary for generated tools.

## Decision

A new host package, `dsh-tool-a2ui-store`, adds two things:

- **`ctx.a2uiStore` capability** — `list`/`save`/`delete` over a filesystem directory defaulting to `<harness home>/a2ui-tools/`, one JSON document per tool. Each save is an atomic replace (`writeFileAtomic`: temp sibling + rename, `0o600` file / `0o700` directory), so a concurrent reader always sees a complete document. A tool name is a single safe file stem (no separators, not `.`/`..`, at most 64 chars).
- **`a2ui_export` model tool** — takes a `name` and the same `page` shape `a2ui_surface` renders, canonicalizes it with the shared `canonicalizeA2uiPage`, and writes `<name>.json`. Reusing the shared canonicalizer means a saved file is byte-identical to what the browser renderer trusts, and unknown field types or node roles fail the export rather than persisting something unrenderable.

The store directory lives under the per-user harness home, so in the team shell each account's saved tools are isolated exactly like its other harness files.

## Alternatives considered

**Reuse the settings seam (`settings.yaml`) for saved tools.** Rejected: a single document is a poor distribution unit — "share this one tool" should be one file, not a section edit of a shared settings document. A store of one-JSON-file-per-tool keeps copy-out/copy-in trivial.

**Expose the store over a new Remote namespace immediately.** Adopted in the follow-up popup-window change: a `remote.a2uiStore` namespace (`list`/`open`/`delete`) plus a sidebar footer panel now scan the directory, re-render a saved tool into the addressed session, and delete tools. The host capability remains the complete persistence answer; the Remote namespace is a thin projection over it.

## Consequences

Model-authored pages can now be exported as standalone, distributable JSON files under `$DSH_HOME/a2ui-tools/`. The base bundle mounts the store beside `tool-a2ui-surface`; the tool catalog documents `a2ui_export`. A sidebar panel reaches the store over the `remote.a2uiStore` namespace and re-renders a saved tool by appending a fresh `a2ui/surface` event to the addressed session.
