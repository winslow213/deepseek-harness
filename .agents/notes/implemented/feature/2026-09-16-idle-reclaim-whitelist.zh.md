# Agent Note：空闲实例回收扫描的按用户白名单

Status: implemented

[English](2026-09-16-idle-reclaim-whitelist.md) | 中文

## Problem

账号服务在无代理流量满 `TEAM_IDLE_TIMEOUT_SECS`（默认30分钟）后回收成员已 spawn 的 `dsh` 实例，以释放内存，前提假设是下次登录冷启动的代价很小。这个阈值是单个全局配置：运营者若想让某个账号的实例不论是否活跃都常驻（演示账号、长时间无人值守的后台任务、对冷启动延迟敏感的用户），除了把超时时间调大给所有账号生效之外没有别的办法——而这会让共享同一台主机的其余约200个注册成员的内存回收目标落空。

## Decision

`dsh_users` 新增 `idle_exempt BOOLEAN NOT NULL DEFAULT false` 列（沿用 `dsh_instances.launch_token`/`last_seen_at` 已经用过的幂等 `ALTER TABLE IF NOT EXISTS` 迁移模式）。回收扫描（`InstanceManager.reapIdle`，`shell/src/account/instance-manager.ts`）每隔 `IDLE_SWEEP_INTERVAL_SECS` 调用一次的 `InstanceStore.idleUsers` 查询联表 `dsh_instances` 与 `dsh_users`，排除 `idle_exempt` 为真的行，因此被豁免用户的实例无论 `last_seen_at` 多久没更新都不会进入回收候选列表。唯一的写入路径是 `UserStore.setIdleExempt(userId, exempt)`，运营者侧通过 `account-cli set-idle-exempt <username> <on|off>`（`shell/src/account/cli.ts`）暴露，与既有的 `reset-password`/`reset-agent-token` 运营 CLI 模式保持一致，而不是新增一个管理端 HTTP 路由。

该字段是按用户而非按实例的：它落在 `dsh_users`（身份数据）而不是 `dsh_instances`（每次回收/停止都会被删除、下次 spawn 才重建的临时注册数据）上，这样白名单能跨越停止/启动周期持续生效，不需要每次冷启动后重新设置。

## Alternatives considered

**做成按用户的空闲超时覆盖字段（数值），而不是布尔豁免。** 被否决：没有人要求"更长但仍有限"的按用户超时，只是要特定账号永不被回收；布尔值是满足这个需求更简单的机制，如果后续真的出现按用户超时的需求，再加一个数值覆盖列也不会取代这个字段。

**新增管理端 HTTP 接口（`PATCH /api/users/:id`），而不是仅限CLI的命令。** 被否决：其余所有账号变更操作（`create-user`、`reset-password`、`reset-agent-token`）都只走运营 CLI、没有 HTTP 入口；只为这一个字段加一个管理路由，会让它成为该服务里唯一可写的用户字段 HTTP 接口，这种不对称没有额外收益，因为运营者做账号变更本来就是对同一个数据库跑 CLI。

**把该字段放在 `dsh_instances` 而不是 `dsh_users` 上。** 被否决：`dsh_instances` 的行会在每次停止/回收时被 `InstanceStore.remove` 删除，只有下次 spawn 时通过 `upsert` 重新出现——这会导致被豁免账号的实例第一次重启（例如一次部署之后）时，白名单就被悄悄丢弃，与本次要加的"不论活跃与否都常驻"保证正好相反。

## Consequences

运营者现在可以让特定账号的实例无限期常驻，而不需要改动全局的 `TEAM_IDLE_TIMEOUT_SECS`，代价是被豁免账号约270MB的基线 RSS 会永久占用而不会在会话之间被回收——如果运营者豁免了很多账号，就是在用回收扫描本该提供的内存容量余量去换这个便利。这次改动没有新增 HTTP 接口，所以豁免操作仍需直接使用 CLI/数据库访问，而不是自助式的界面开关。
