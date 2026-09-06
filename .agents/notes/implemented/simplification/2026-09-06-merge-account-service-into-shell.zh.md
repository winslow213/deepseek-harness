# Agent Note: 将账号服务并入 team shell

Status: implemented

[English](2026-09-06-merge-account-service-into-shell.md) | 中文

## 问题

Team 账号服务（`team/`）与 team shell 服务面（`shell/`）在实例生命周期上存在重复。账号服务分配端口，以子进程方式启动 `TEAM_SHELL_COMMAND spawn-user <user> <port>`，解析子进程 stdout 的 `USER URL: …` 行以提取 launch token，再登记；而 `shell/src/spawn-user.ts` 里已经有为同一类每用户实例服务的 `superviseUserInstance`，`shell/src/instance-register.ts` 又通过 HTTP 回环到账号服务登记同一行数据。两个同级目录、第二个 `package.json`、以及脆弱的 stdout 契约之所以存在，仅仅是因为设计记录里把账号层规划为独立交付。

## 决策

账号服务作为 `shell/src/account/` 进入 shell 内部。shell 的 `package.json` 增加 `pg` + `ioredis` 依赖——这是 shell 唯一需要第三方包的表面；remote agent（`shell/src/remote/agent.ts`）与 shell 其余部分保持仅 node 内建 import，因此成员仍可从裸 checkout 无需 install 运行 agent。`team/` 目录及其 `package.json` 被移除。

实例启动不再跨越进程边界。`account/instance-manager.ts` 在进程内调用 `superviseUserInstance(user, port, { onReady })`；`onReady` 钩子在每一代实例（第一代在登录响应前以确定性 await 登记，后续插件安装触发的重启经钩子登记）直接通过 `InstanceStore` 写 `dsh_instances` 行。子进程 spawn、`USER URL: (\S+)` stdout 解析、以及 `TEAM_SHELL_COMMAND`/`TEAM_SHELL_ARGS`/`TEAM_ACCOUNT_URL`/`DSH_USERS_ROOT`/`DSH_ENTRY_HOST`/`TEAM_INSTANCE_STARTUP_TIMEOUT_MS` 转发全部删除。`spawn-user.ts` 新增 `SuperviseOnReady`（`superviseUserInstance` 的一个选项）和 `SupervisedInstance` 上的 `exited` promise，使 manager 能观察监督循环结束并删除登记。

入口为 `dsh-shell account`（服务）与 `dsh-shell account-cli`（operator CLI），均在 `shell/src/bin.ts` 下。`TEAM_DB_URL` 与 `TEAM_REDIS_URL` 仍必填；`DSH_USERS_ROOT` 与 `DSH_ENTRY_HOST` 由 `spawn-user` 从共享 `.env` 直接读取，保持不变。

## 曾考虑的替代方案

**保留两个目录，仅通过 import 共享 `spawn-user.ts`。** 拒绝，因为账号层与服务面是同一产品表面；保留第二个 `package.json` 与第二个 `tsconfig` 只会保留制造重复的拆分，而没有换来 workspace 边界之外任何隔离。

**保留 HTTP 登记回环以去掉第三方依赖。** 拒绝，因为进程内监督严格更简单：无需子进程所有权、无需 stdout 契约、无需登记 HTTP 客户端、也无需维护启动超时的 env 表面。

**让 `spawn-user` 直接 import 账号 store。** 拒绝，因为账号服务是登记与端口分配的所有者；`spawn-user.ts` 保持为无进程的实例运行器，通过登记钩子扩展，而不是获得数据库依赖。

## 后果

一个目录、一个 `package.json`、一个 CLI。`team/` 树、其 lockfile、以及 `TEAM_SHELL_COMMAND`/`TEAM_SHELL_ARGS` env 管线全部移除。shell 不再是统一零依赖：`npm install` 现在会为账号表面拉取 `pg` 与 `ioredis`，而面向成员的 agent 路径仍仅用 node 内建。`dsh_instances` 的 PID 直接取自被监督的子进程，修复了子进程 + 自登记拆分造成的 null-PID 覆盖问题。关闭时停止进程内 supervisor，由其停止子进程，因此不会再遗留孤儿 dsh web 实例。
