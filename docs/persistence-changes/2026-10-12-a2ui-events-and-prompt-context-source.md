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
    previous: "2026-10-05-working-directory-attribution"
    after: "65cc06fbeaaac8d92315577985d9170ad81667e328c5c06bcb8fa16c01e196be"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "8489bbc80a08ca211cdf9c3cddfc523a06235df6f7be7aae4441b03e54d67308"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "74ec83b1bdce64b4ae41d2cfd2790914b5cdcc88461548e61ae3ea0ef4ad4290"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "d8445aa028e96f9119c363fe0631a80fd8b002640dc2788e08c5ba58109bf47a"
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
