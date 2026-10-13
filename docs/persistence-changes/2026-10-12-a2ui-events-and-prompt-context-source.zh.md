---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-12-a2ui-events-and-prompt-context-source

[English](2026-10-12-a2ui-events-and-prompt-context-source.md) | 中文

## 概述

记录 A2UI 表面存储的两个事件类型，以及提示路由代提交者记录消息时写入的 prompt-context 消息来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

两个 A2UI 事件是 SessionEventMap 的新成员，并已加入本构建的已知事件类型集合，因此本构建可以读取它们。两者都不携带 envelope 的 ignorable 标记，因此在读取时仍属必需：更早的构建会拒绝含有它们的日志，而不是静默跳过一条会重建部分表面状态的记录。

prompt-context 是 merge-extensible 的 MessageSourceMap 的新变体，这改变了 agent/inbox/spliced、developer/message、session/title-llm-request 与 user/message 的记录签名。消费者对无法识别的来源 kind 已有既定的兜底分支，因此这些记录保持原有含义，且没有字段变为必需。日志结构未变，SessionHeader.version 未提升，因此各 root 均采用 same-version。

<a id="verification"></a>
## 验证

命令 npx vitest run --no-coverage packages/web/tool-a2ui-surface packages/web/tool-a2ui-store packages/api/session-controller packages/core/session 通过 67 个文件、1630 个测试。session-models.host.spec.ts 中的一个 it.each 用例在该并发下触发 5 秒超时，单独运行该文件时 26/26 通过，因此属调度负载而非行为问题。

<a id="dev-note"></a>
## 开发备注

无。
