# Agent Note: A2UI 动态数据源提供者 seam

状态：已实现

[English](2026-09-09-a2ui-data-source-provider.md) | 中文

## 问题

A2UI `select` 字段的选项有两个作者：模型（静态 `options`）或模型书写的 `script` 动作（`optionsFrom`）。两者都无法提供实时的、由部署方拥有的数据源——`hdc list targets` 的设备列表、目录列表、指标读取。把这些数据写进页面会让模型耦合它无法知晓的事实，而 `script` 动作让模型提供可执行逻辑而非指认一个可信来源。[动态数据源提案](../../proposed/feature/2026-09-08-a2ui-dynamic-data-and-live-results.zh.md)把此列为其首个能力：`select` 字段声明一个稳定的 `source`，由宿主提供的 provider 解析它。

## 决策

此决策仅部分取代 [A2UI 动态数据源与实时结果通道](../../proposed/feature/2026-09-08-a2ui-dynamic-data-and-live-results.zh.md) 中的数据源绑定能力（提案第 1 项）；该 note 对实时结果通道与脚本化 local actions 仍然有效。`select` 字段声明一个由新能力 seam 解析的 `source` 名称，以随附的 bash 提供者作为参考实现。

- **`source` 字段。** `A2uiField` 增加一个 `source` 字符串，规范化时与静态 `options` 和 `optionsFrom` 互斥，且仅在 `select` 字段上有效。模型书写的是名称，从不书写数据。
- **Provider seam。** 新包 `dsh-tool-a2ui-data` 声明 `A2uiDataProvider` 契约（`has(source)` / `resolve(source, args) → { items }`）以及 `a2uiData` Remote 命名空间的所有者。provider 是组合选择；`dsh-tool-a2ui-data-bash` 是基于 `ctx.shell` 的随附实现。
- **Bash provider。** `dsh-tool-a2ui-data-bash` 通过组合进来的 shell 服务，为每个白名单 source 运行一条由 operator 配置的命令。命令可用 `{fieldName}` 占位符，填入 POSIX 单引号包裹的词，因此收集到的值无法拼接命令语法；stdout 被解析为 JSON 数组、`{ items: [...] }` 信封或逐行修剪的文本。
- **客户端流程。** popup 在挂载时请求每个 `source`（`a2ui/data-request`）；launcher 通过 `ctx.remote.a2uiData.resolve` 解析并把选项回传（`a2ui/data`）或失败（`a2ui/data-failed`）。失败的 source 退化为空 select，而不是让页面失败。

## 备选方案

**复用 `optionsFrom` script 动作。** 模型书写的脚本本可填充选项。否决：`optionsFrom` 让模型提供可执行逻辑，而非指认可信来源；部署方拥有的白名单需要一条 operator 配置、模型无法书写的命令。

**用持久化 `a2ui/data` 事件做 replay。** 提案把每次 resolve 记为 session 事件，使 replay 无需重跑 provider 即可渲染相同选项。暂缓：选项列表对模型不可见（只有选中的值进入 submit 载荷），且 `Session.append` 无法把事件标记为 `ignorable`，因此本次变更不含持久化事件，popup 每次挂载时重新请求。

## 后果

页面现在可以从部署方控制的 source 拉取选项，而模型无需书写数据或可执行逻辑。选项经由 Remote 返回值而非 session 事件传输，因此重新请求会再次运行 provider；首次挂载时 source 参数为空，依赖字段的 source 留待后续的刷新机制。bash provider 是该 seam 的参考实现，部署方可在 surface 工具旁替换为自己的 provider。
