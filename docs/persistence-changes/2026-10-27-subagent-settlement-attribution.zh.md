---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-27-subagent-settlement-attribution

[English](2026-10-27-subagent-settlement-attribution.md) | 中文

## 概述

为持久化的子代理结算通知增加可选 stopReason 归属信息，保持 Session 格式版本不变。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

新读取方接受缺少 stopReason 的历史通知，不得从英文摘要推断该字段。写入方始终记录已捕获执行的确切 stopReason。旧读取方保留额外的 source 元数据，继续使用已有 kind、notice form、summary、senderSessionId 和未改变的内容；原生 V4 source 准入校验生产方 kind，不拒绝额外归属字段。新元数据只影响展示，不影响回放、权限或恢复。无需迁移或提升 Session 版本。

<a id="verification"></a>
## 验证

定向 Vitest 运行通过：continuation-messages.spec.ts（14 个测试）、external-activation.spec.ts（19 个测试）、continuation-messages-adapter.spec.ts（1 个测试）和 continuation.spec.ts（166 个测试），均位于 packages/subagent/subagent/tests。命令为 node node_modules/vitest/vitest.mjs run，后接上述测试文件路径。覆盖全部五种终止原因、历史归属信息不作推断、外部清理失败保留已捕获的执行原因、冷恢复，以及不变的 DeepSeek Messages 线协议内容。历史 Session 代际保持不变；受影响的当前格式快照预期包含 stopReason。

<a id="dev-note"></a>
## 开发备注

无。
