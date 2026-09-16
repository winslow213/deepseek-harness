# Agent Note：空闲实例回收扫描的按用户白名单

Status: implemented

[English](2026-09-16-idle-reclaim-whitelist.md) | 中文

## Problem

账号服务在无代理流量满 `TEAM_IDLE_TIMEOUT_SECS`（默认30分钟）后回收成员已 spawn 的 `dsh` 实例，以释放内存，前提假设是下次登录冷启动的代价很小。这个阈值是单个全局配置：运营者若想让某个账号的实例不论是否活跃都常驻（演示账号、长时间无人值守的后台任务、对冷启动延迟敏感的用户），除了把超时时间调大给所有账号生效之外没有别的办法——而这会让共享同一台主机的其余约200个注册成员的内存回收目标落空。

## Decision

`dsh_users` 新增 `idle_exempt BOOLEAN NOT NULL DEFAULT false` 列（沿用 `dsh_instances.launch_token`/`last_seen_at` 已经用过的幂等 `ALTER TABLE IF NOT EXISTS` 迁移模式）。回收扫描（`InstanceManager.reapIdle`，`shell/src/account/instance-manager.ts`）每隔 `IDLE_SWEEP_INTERVAL_SECS` 调用一次的 `InstanceStore.idleUsers` 查询联表 `dsh_instances` 与 `dsh_users`，排除 `idle_exempt` 为真的行，因此被豁免用户的实例无论 `last_seen_at` 多久没更新都不会进入回收候选列表。唯一的写入路径是 `UserStore.setIdleExempt(userId, exempt)`，有两个调用方：运营者侧的 `account-cli set-idle-exempt <username> <on|off>`（`shell/src/account/cli.ts`，可操作任意账号）和会话作用域的 `POST /api/me/idle-exempt`（`shell/src/account/http.ts`，只能操作当前登录成员自己的账号，跟 `/api/pairings` 一样通过 `sessionUser` 解析调用者）。`GET /api/me` 把该字段以 `user.idleExempt` 回传，供设置页展示当前状态。

该字段是按用户而非按实例的：它落在 `dsh_users`（身份数据）而不是 `dsh_instances`（每次回收/停止都会被删除、下次 spawn 才重建的临时注册数据）上，这样白名单能跨越停止/启动周期持续生效，不需要每次冷启动后重新设置。

客户端一侧是设置页 General 分组下的一行（`packages/client/ui-team-account/src/client/IdleExemptRow.tsx`，与同一个包里已有的"生成配对码"、"退出登录"行并列注册），挂载时从 `/api/me` 读取当前状态，通过 `Switch` 控件调用 `POST /api/me/idle-exempt` 切换，渲染门槛与另外两行一致，都靠 `<meta name="team-shell">` 标记。

## Alternatives considered

**做成按用户的空闲超时覆盖字段（数值），而不是布尔豁免。** 被否决：没有人要求"更长但仍有限"的按用户超时，只是要特定账号永不被回收；布尔值是满足这个需求更简单的机制，如果后续真的出现按用户超时的需求，再加一个数值覆盖列也不会取代这个字段。

**新增能操作任意账号的管理端 HTTP 接口（`PATCH /api/users/:id`）。** 被否决：其余所有账号变更操作（`create-user`、`reset-password`、`reset-agent-token`）都只走运营 CLI、没有 HTTP 入口；加一个能对任意用户 id 设置该字段的管理路由，会成为该服务里唯一可对任意用户可写字段的 HTTP 接口。最终落地的自助式 `/api/me/idle-exempt` 路由性质不同：它从调用者自己的会话解析目标（跟 `/api/pairings` 一样），永远不能改动别的账号，也不需要 `adminSecret` 门禁。

**把该字段放在 `dsh_instances` 而不是 `dsh_users` 上。** 被否决：`dsh_instances` 的行会在每次停止/回收时被 `InstanceStore.remove` 删除，只有下次 spawn 时通过 `upsert` 重新出现——这会导致被豁免账号的实例第一次重启（例如一次部署之后）时，白名单就被悄悄丢弃，与本次要加的"不论活跃与否都常驻"保证正好相反。

## Consequences

任何已登录成员现在都能自己让实例常驻，不需要运营者介入，代价是被豁免账号约270MB的基线 RSS 会永久占用而不会在会话之间被回收——因为这个开关是自助式而非运营者管控的，回收扫描本该提供的内存容量余量现在取决于有多少成员会去打开它，而不只是运营者的策略。如果容量吃紧，运营者仍可以直接审计或强制清除该标记（`account-cli set-idle-exempt <username> off`）。
