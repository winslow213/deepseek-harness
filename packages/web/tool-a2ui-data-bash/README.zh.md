---
description: "bash-backed 的 A2UI 数据源 provider：经 shell 服务运行一条操作者配置的命令，把白名单中的 source 名解析为 select 字段的选项。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-a2ui-data-bash

[English](README.md) | 中文

## 概述

`dsh-tool-a2ui-data-bash` 是 A2UI 动态数据源能力的随发行版 provider。它提供 `ctx.a2uiData` 并挂载 `a2uiData` Remote 控制器，经组合的 `shell` 服务运行一条操作者配置的命令，把每个白名单中的 source 名解析为 `select` 字段的选项。source → 命令白名单是部署方显式、经过校验的表面：模型（经页面 DSL）只能命名 `source`，从不提供命令，因此页面无法经数据源通道触达任意主机执行。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本包挂在 surface 工具与数据源能力旁。它提供 `ctx.a2uiData` 并注册 `a2uiData` Remote 控制器。

### 最小配置

```yaml
- id: tool-a2ui-data-bash
  name: '@deepseek-ai/dsh-tool-a2ui-data-bash'
  config:
    sources:
      hdc-devices:
        command: "hdc list targets"
        timeoutMs: 10000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sources` | `{}` | source 名 → `{ command, timeoutMs? }`；页面只能命名这里的某个键。 |
| `sources.<name>.command` | 必填 | 产生选项的 shell 命令；可用 `{fieldName}` 占位符从已收集字段值填充。 |
| `sources.<name>.timeoutMs` | shell 默认 | 运行上界（毫秒）。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-a2ui-data-bash)是所有可接受字段的详尽来源。

### 选项输出

命令的 stdout 以三种可接受形态变成选项：`{label,value}` 记录的 JSON 数组、JSON `{ items: [...] }` 信封，或纯文本行（每个非空 trim 行成为一个选项，其 label 与 value 都是该行）。无效条目被跳过；非零退出以 stderr 详情使解析失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[`src/index.ts`](src/index.ts) 定义白名单 schema，用 POSIX 单引号词填充 `{fieldName}` 占位符（因此收集到的值无法拼接进命令语法），经 `ctx.shell.run` 以 1 MiB stdout 上限运行解析出的命令，并把输出解析为选项。`BashA2uiDataProvider` 实现 `ctx.a2uiData` 契约；`apply` 提供它并挂载 `A2uiDataController`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-tool-a2ui-data](../tool-a2ui-data/README.zh.md)——本 provider 所实现的 capability 契约与 Remote 命名空间。
- [dsh-shell](../../shell/shell/README.zh.md)——运行每条 source 命令的执行器。

-----

<a id="model-experience"></a>
## 模型体验

无。本包是主机 provider，没有面向模型的工具；它只运行部署方为命名 source 配置的命令。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **source 在组合期固定**——白名单是部署配置而非模型书写；新增 source 需要编辑 cordis.yml 并重启。
- **每个 source 一条命令**——一个 source 运行单条命令；顺序执行或管道属于命令字符串本身。
- **占位符仅在首次挂载生效**——弹窗以空参数请求 source，因此 `{fieldName}` 占位符只能解析页面在打开时已持有的值。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

bash provider 是[A2UI 动态数据源提案](../../../.agents/notes/proposed/feature/2026-09-08-a2ui-dynamic-data-and-live-results.zh.md)所述数据源 seam 的参考实现。

</details>

**运行时不变式：** 不发布伴生包。provider 除白名单外不拥有任何运行时状态；其 resolve 与 fill 行为由单元测试固定。
