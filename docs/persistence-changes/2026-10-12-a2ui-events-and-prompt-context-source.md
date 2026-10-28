---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-12-a2ui-events-and-prompt-context-source

English | [中文](2026-10-12-a2ui-events-and-prompt-context-source.zh.md)

## Summary

Records the two A2UI surface-store event types and the `prompt-context` message source the prompt route writes when it logs a message on a submitter's behalf.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-12-a2ui-events-and-prompt-context-source
baseline: false
changes:
  - root: "event:a2ui/surface"
    previous: null
    after: "1a0a397eb45fcf6aef3dc1d029c91209ba2e1e863f1c6da33d8bfb8b07ae3da6"
    decision: same-version
  - root: "event:a2ui/update"
    previous: null
    after: "5eae8b7f80854aeda147cf25238d45a2c1f63fcf25481163e1d8913f2517fdf5"
    decision: same-version
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "8c15e1f620dde8ef109e9e60599882c0a44d2bad436fc83a6ee76ea2e96176d6"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "d3791e85b77a7fb8783ce98501c9e04fd39640563de305d4a5377b3e3cac7704"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "e212ba89f185f7436144044e99f581837f9273e7bcbd796dcbbdf3b7618eaa35"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "e66b4de94cc37fa9b356eb6bb8b5eb1fb6cf574453371de7a517f571dfe6d104"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both A2UI events are new `SessionEventMap` members and join this build's known event types, so this build reads them. Neither carries the envelope's `ignorable` marker, so they stay required on read: an earlier build refuses a log containing them instead of silently skipping a record that reconstructs part of the surface state.

`prompt-context` is a new variant of the merge-extensible `MessageSourceMap`, which changes the recorded signature of `agent/inbox/spliced`, `developer/message`, `session/title-llm-request`, and `user/message`. Consumers already fall through a documented default for an unrecognized producer kind, so those records keep their existing meaning and no field becomes required. The log structure is unchanged and `SessionHeader.version` does not move, so every root takes `same-version`.

<a id="verification"></a>
## Verification

`npx vitest run --no-coverage packages/web/tool-a2ui-surface packages/web/tool-a2ui-store packages/api/session-controller packages/core/session` passed 67 files and 1630 tests. One `it.each` case in `session-models.host.spec.ts` hit the 5s timeout at that concurrency and passes 26/26 when its file runs alone, so the failure is scheduling load rather than behavior.

<a id="dev-note"></a>
## Dev Note

None.
