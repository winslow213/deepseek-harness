---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-27-subagent-settlement-attribution

English | [中文](2026-10-27-subagent-settlement-attribution.zh.md)

## Summary

Adds optional stopReason attribution to persisted subagent settlement notices while keeping the Session format version unchanged.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-27-subagent-settlement-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-12-a2ui-events-and-prompt-context-source"
    after: "41b60757a7ed8e1e3c7645e6c73ae6a51f7fa36ddb2091a8891be7dd12d1f650"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-12-a2ui-events-and-prompt-context-source"
    after: "167c47cd67b0019dead55deeadcc02f1f2a1b780422b8f09bbcaabe7e091c1ea"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-12-a2ui-events-and-prompt-context-source"
    after: "25b83c647e6db60cbda769499e62a6535b3239c88dc2b9a169bd82523b5d6645"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-12-a2ui-events-and-prompt-context-source"
    after: "9783b1f5c2abbae0e8b42119537cd984c1553887347e5c31c17ed21867a8e6fb"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New readers accept historical notices without stopReason and must not infer it from the English summary. Writers always record the exact captured execution stopReason. Older readers preserve additional source metadata and continue using the existing kind, notice form, summary, senderSessionId, and unchanged content; native V4 source admission validates the producer kind rather than rejecting additional attribution fields. The new metadata affects presentation only, not replay, authority, or recovery. No migration or Session version bump is required.

<a id="verification"></a>
## Verification

Focused Vitest runs passed: continuation-messages.spec.ts (14 tests), external-activation.spec.ts (19 tests), continuation-messages-adapter.spec.ts (1 test), and continuation.spec.ts (166 tests), all under packages/subagent/subagent/tests. Command: node node_modules/vitest/vitest.mjs run followed by the listed owner paths. Coverage includes all five terminal reasons, historical attribution without inference, external cleanup failure retaining the captured execution reason, cold resume, and unchanged DeepSeek Messages wire content. Historical Session generations remain unchanged; affected current-format snapshot expectations include stopReason.

<a id="dev-note"></a>
## Dev Note

None.
