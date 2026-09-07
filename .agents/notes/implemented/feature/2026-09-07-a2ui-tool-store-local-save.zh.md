# Agent Note: 用于本地保存与分发的 A2UI 工具存储

Status: implemented

[English](2026-09-07-a2ui-tool-store-local-save.md) | 中文

## Problem

模型生成的 A2UI 页面只作为持久会话记录存在：模型生成的 DSL、字段逻辑（`visibleWhen`/`validateWhen`/`compute`）以及 `actions` 都被困在单个会话日志里。团队无法把页面保存为文件、分享给其他成员或部署，也无法在不重新生成的情况下重新导入——生成的工具没有分发边界。

## Decision

新的宿主包 `dsh-tool-a2ui-store` 增加两点：

- **`ctx.a2uiStore` 能力** —— 对默认位于 `<harness home>/a2ui-tools/` 的文件系统目录提供 `list`/`save`/`remove`，每个工具一个 JSON 文档。每次保存都是原子替换（`writeFileAtomic`：临时兄弟文件 + rename，文件 `0o600`／目录 `0o700`），使并发读者始终看到完整文档。工具名是单一安全文件词干（无分隔符、非 `.`/`..`、至多 64 字符）。
- **`a2ui_export` 模型工具** —— 接收 `name` 与 `a2ui_surface` 渲染所用的同一 `page` 结构，用共享的 `canonicalizeA2uiPage` 规范化后写入 `<name>.json`。复用共享规范化器意味着保存的文件与浏览器渲染器所信任的内容逐字节一致，未知字段类型或节点角色会拒绝导出，而不是持久化不可渲染的内容。

存储目录位于每用户 harness 主目录下，因此在团队 shell 中每个账户已保存的工具与它其他 harness 文件一样隔离。

## Alternatives considered

**复用 settings 接缝（`settings.yaml`）保存工具。** 否决：单一文档是糟糕的分发单位——「分享这一个工具」应是一个文件，而非对共享 settings 文档做一段编辑。每工具一个 JSON 文件的存储让拷出/拷入变得简单。

**立即通过新 Remote 命名空间暴露存储。** 推迟：宿主能力已是完整的持久化答案；在浏览器侧接上列表/重渲染需要 Remote 命名空间与客户端面板，它们是独立的面，保存文件并不需要它们。

## Consequences

模型生成的页面现在可以导出为 `$DSH_HOME/a2ui-tools/` 下独立、可分发的 JSON 文件。base bundle 在 `tool-a2ui-surface` 旁挂载该存储；工具目录记录了 `a2ui_export`。该能力仅限宿主侧——将来扫描目录并重渲染已保存工具的客户端面板将通过 Remote 命名空间触达它，这不属于本次改动。
