# Agent Note: 工作流节点配置（persona 与工具范围）关联预设 profile

Status: implemented

[English](2026-08-25-workflow-agent-profile-node-config.md) | 中文

## 问题

工作流脚本通过 `agent()` 把任务分发给许多 subagent，但此前每个子 agent 都运行在部署级 persona 与部署级工具集上。多角色编排——如审查员、写作者、复核者——需要每个节点拥有独立的身份与工具范围，独立于部署配置；而且这种节点级配置应当能像预设 profile 一样在不同部署间复用。

`agent()` 的选项集合是封闭协议，由 worker runtime 中硬编码的白名单强制约束。增加选项属于底座改动，不是插件钩子能实现的；宿主也不得自行编造脚本没有要求的行。

## 决策

节点级配置由两层交付。

引擎层新增一个选项：`agent(prompt, { profile })` 指定一个预设，其节点配置为该子 agent 提供默认的 `persona`/`toolFilter`。worker 白名单接受 `profile`，校验其为字符串，并在 `ChildStartRequest` 中透传。宿主解析指定的 profile，并与调用中的显式选项合并：显式 `persona` 替换 profile 的整个字段，显式 `toolFilter` 独立替换 profile 的 `allow` 与 `deny`。调用未命名的字段保留 profile 的值。

预设层提供 profile。每个预设目录可以携带 `profile.yml`，声明 `persona` 和/或 `tools: { allow?, deny? }`。发现流程将其解析为预设行上的 `NodeProfile`；格式错误的文件作为 `profileProblem` 报告，与 broken 的组合相互独立。`AgentPresets.resolveNodeProfile(id)` 返回该行的节点配置，并在预设未知、缺少 `profile.yml` 或文件不可用时大声失败。

profile 解析是机会式的，与 subagent 组合继承同理：`agent-presets` 是可选 peer 依赖，未组合 roaster 的部署会按子 agent 大声失败，而不是静默丢弃脚本要求的 persona/toolFilter。工作流工具描述记录 `profile` 契约。

## 验证

预设层由 `readNodeProfile` 解析测试、发现测试（扫描到的预设携带其解析出的 profile 或问题）以及服务测试（`resolveNodeProfile` 在已声明 profile 上成功，并拒绝缺失或格式错误的 profile）覆盖。引擎层由 session 测试（`profile` 校验与在 start 请求上的透传）以及 worker-thread 测试（宿主把 profile 的 persona/toolFilter 解析到子请求、显式选项逐字段覆盖 profile、未组合 roaster 时大声失败）覆盖。两个包的 README 与工作流工具描述都记录了新选项。

## 曾考虑的替代方案

**不修改引擎，通过插件钩子暴露该选项。** 拒绝：`agent()` 选项是封闭协议，钩子无法扩展 worker 白名单会拒绝的内容；要支持 `profile` 仍需要本次决策所做的底座改动。

**在整个扇出过程中共享一个 agent 的上下文。** 拒绝：需求是按节点分发独立 agent，并各自独立配置，而不是在多次委派间复用同一份上下文。

**引擎硬依赖 `agent-presets`。** 拒绝：roaster 在部署中是可选的，硬依赖会把预设强制带到所有部署。可选 peer 加使用处大声失败，让引擎在无预设时仍然可用。

**把显式 persona 与 profile 的合并。** 拒绝：persona 是整体身份字符串，因此显式值替换 profile 的整个字段。只有 `toolFilter` 合并，且仅在 `allow`/`deny` 字段层面。

## 后果

每个工作流节点可以独立配置身份与工具范围，跨脚本和部署复用预设的 profile，并按节点隔离权限（例如对复核子 agent 拒绝 shell）。编辑预设的 `profile.yml` 会改变此后每个引用它的子 agent，无需改代码。

代价是间接性：`agent({ profile })` 在运行时对 roaster 解析，因此脚本必须引用存在且声明了 profile 的预设；未组合 roaster 的部署完全无法支持该选项。新增的 `ChildStartRequest` 字段位于私有 worker 协议中，因此 session 日志格式不变；对模型可见的表层是工作流工具描述。
