# Agent Note: 团队 shell 的每用户工作区隔离

Status: implemented

[English](2026-09-07-team-shell-per-user-workspace-confinement.md) | 中文

## Problem

每个团队 shell 账户的 dsh 实例都跑在共享服务器文件系统上。部署默认的 `sandbox-policy.workspaceRoot` 是 `process.cwd()`（仓库根，所有账户共享），region-router 的本地 `cwd` 也是共享的 `/tmp`。因此写入只被共享根所围栏，而 dsh 的文件系统沙箱有意**不围栏读取**——一个成员可以读到另一个成员的凭据、会话与工作区文件。

## Decision

每个账户获得一个私有工作区目录 `$DSH_HOME/workspace`，在 provision 时创建，并作为读写两者的隔离根。

- **写边界。** `provisionUserHome` 向 home patch upsert 第二个标记块（`dsh-team-sandbox`），用 `workspaceRoot: !!js process.env.DSH_WORKSPACE_ROOT` 覆盖 `sandbox-policy`，`teamChildEnv` 把 `DSH_WORKSPACE_ROOT` 设为该账户工作区。部署模式仍由 operator 通过 `DSH_PERMISSION_MODE` 控制。
- **读边界。** `region-router`（即注入的 `ctx.fs`）新增 `workspaceRoot` 配置，把本地 `stat`/`lstat`/`readText`/`readBytes`/`listDir` 围栏到该根，越界抛 `FS_PERMISSION_DENIED`。已挂载的 shadow 树目标仍走远端、跳过围栏；省略 `workspaceRoot` 则保留裸（非团队）region-router 的「任意读」语义。
- region-router/shell 的 `cwd` 与 region-router 的 `workspaceRoot` 都指向账户工作区，使相对操作与默认 shell 工作目录落在边界内。

## Alternatives considered

**只做写围栏（sandbox-policy workspaceRoot）。** 否决为不足：dsh 的 fs 沙箱按设计仅限写入——读取不设防——共享服务器会让每个账户的凭据与会话文件对其它账户可读。

**用每用户独立沙箱后端做内核级读隔离。** 否决为超出范围：团队 shell 共享同一宿主内核，region-router 内进程内的读围栏对「模型控制路径」威胁已是完整答案，与既有 fs-sandbox 依据一致（受信代码内的围栏，而非内核边界）。

**复用 agent 的 `--root` 风格白名单。** 否决：该白名单约束的是远端 agent 自己的主机，而非 region-router 所前置的服务器本地 fs 面。

## Consequences

每个账户只能读写 `$DSH_HOME/workspace` 内的路径与其已挂载的 shadow 根。`dsh-team-sandbox` 块幂等，并与 `dsh-team-llm` 块及 home patch 里任何 operator 行共存。既有账户在下一次 provision（登录）时获得工作区目录与 patch；已运行实例需重启。读围栏只作用于注入的 region-router——成员若删除生成的 profile patch 会回退到本地 provider，因此该围栏是团队 shell 的默认，而非内核级保证。
