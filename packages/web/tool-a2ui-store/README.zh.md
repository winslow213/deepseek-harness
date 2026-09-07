---
description: "A2UI 工具存储：模型如何把生成的页面保存为可在 harness 主目录下分发的 JSON 文件，以及部署如何重新导入已保存的工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-a2ui-store

[English](README.md) | 中文

## Summary

借助 `dsh-tool-a2ui-store`，模型用 `a2ui_surface` 生成的页面可以保存为独立文件并分享：`a2ui_export` 工具与 `ctx.a2uiStore` 能力把规范的页面定义——声明式 DSL、字段逻辑（`visibleWhen`/`validateWhen`/`compute`）以及 `actions`——按「每个工具一个 JSON 文档」持久化到 `<harness home>/a2ui-tools/`。每次写入都是原子替换，读取时畸形的文档会被跳过而不遮蔽其余文件。存储层就是分发边界：保存的文件可在部署之间复制、重新导入，而无需重新生成页面。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

在需要让 agent 持久化其所生成页面的地方挂载此包。它在工具注册表上注册 `a2ui_export` 工具，并提供 `ctx.a2uiStore`。

### Minimal configuration

```yaml
- id: tool-a2ui-store
  name: '@deepseek-ai/dsh-tool-a2ui-store'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dir` | `<harness home>/a2ui-tools` | 存储目录；显式路径覆盖默认值 |

生成的 [配置目录](../../../docs/config-catalog.md#deepseek-aidsh-tool-a2ui-store) 是权威来源。

### The save loop

模型调用 `a2ui_export`，传入 `name` 与 `a2ui_surface` 渲染所用的同一 `page` 结构。页面经规范化（未知字段类型与节点角色被拒绝）后写入 `<dir>/<name>.json`；同名保存会替换文件。`ctx.a2uiStore` 向宿主消费者暴露同样的 `list`/`save`/`remove` 操作，保存记录携带页面与 ISO 格式的 `savedAt` 时间戳。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现内部 —— 点击展开</summary>

存储层是轻量、依赖极少的文件系统层。`store.ts` 解析目录（显式覆盖优先，否则 `$DSH_HOME/a2ui-tools`），用 `writeFileAtomic`（临时兄弟文件 + rename，文件 `0o600`／目录 `0o700`）写入每个工具，使并发读者始终看到完整文档，并按名称排序的 `.json` 词干列举。工具名必须是单一安全文件词干（无分隔符、非 `.`/`..`、至多 64 字符）。`index.ts` 在 `ctx` 上提供能力并注册 `a2ui_export`，后者复用 `dsh-tool-a2ui-surface` 的 `canonicalizeA2uiPage`，使保存的页面与浏览器渲染器所信任的内容逐字节一致。

### Source map

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`ctx.a2uiStore` 能力、`a2ui_export` 工具注册 |
| [`src/store.ts`](src/store.ts) | 文件系统持久化：带原子写的 resolve/save/list/remove |
| [`src/types.ts`](src/types.ts) | 客户端安全的 `A2uiToolRecord` 与名称安全规则 |

</details>

-----

<a id="model-experience"></a>
## Model Experience

模型看到 `a2ui_export`，带 `name`（稳定文件词干）与 `page`（与传给 `a2ui_surface` 的同一 JSON）。成功时渲染 ``Saved A2UI tool "<name>" to the local tool store.``；页面非法或非 agent 调用方以规范化错误失败。页面 schema 由共享的 [A2UI 页面词汇](../../../docs/tool-catalog.md#deepseek-aidsh-tool-a2ui-surface) 描述。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **存储仅限宿主侧** —— 它在 harness 主目录下持久化文件；把列表暴露给浏览器侧边栏并在客户端重新渲染已保存工具，需要 Remote 命名空间与客户端面板，这不在本包范围内。
- **无实时监听** —— 列表按需读取；其他进程新增的文件在下一次 `list()` 时出现，而非推送。
- **每个工具一个文档** —— 工具是单个 JSON 文件；存储层不做版本或 diff。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

None.

</details>
