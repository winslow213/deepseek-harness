# Agent Note: 每用户实例的空闲回收与登出关闭

Status: implemented

[English](2026-09-06-instance-idle-reclaim-logout.md) | 中文

## Problem

成员的 dsh web 实例从登录一直运行到 account 服务关闭：没有探活、空闲超时或登出钩子，因此 30 个已登录成员意味着 30 个常驻实例（每个约 435MB），只有服务重启才会释放。S6 生命周期目标（full-spawn-on-demand，成员无活跃会话时零进程）需要先补齐两块——活跃信号与显式登出关闭。

## Decision

活跃追踪走既有的路由决策，而非新增端点。`dsh_instances` 增加 `last_seen_at` 列（默认 `now()`，对已有表幂等添加）。proxy 已在每次转发请求时调用 `/api/session/route`，因此 `handleSessionRoute` 每次解析到实例时都经 `InstanceStore.touch` 刷新 `last_seen_at`——活跃会话因此绝不会越过空闲阈值。`InstanceManager` 运行一个 60 秒的 unref 扫描，选取 `InstanceStore.idleUsers(idleTimeoutSecs)` 并对每个 `stop()`，释放 supervisor + dsh web + 端口。阈值由 `TEAM_IDLE_TIMEOUT_SECS` 配置，默认 30 分钟。

登出确定性地关闭实例。`/api/logout` 在销毁 session 前先把 session 解析到用户，再调用 `InstanceManager.stop(userId)`，停止 supervisor、释放其预留端口并删除注册。`SupervisedInstance` 现在暴露 `port`，使 manager 能释放它自己持有的预留。

## Alternatives considered

**在 Redis 里记活跃（`active:<user>` TTL）并经 pub/sub 回收。** 本次范围否决：account 服务本已拥有 `dsh_instances` 行，proxy 也已每请求做路由决策，因此把一列 DB 折叠进该路径无需新的 proxy 依赖、pub/sub 频道或额外端点。

**靠 Redis key 过期通知而非扫描定时器回收。** 否决：keyspace 通知是可选且不保证送达，而对带时间戳列的扫描是单条确定性查询。

**仅在最后一个 session 结束时关闭实例。** 暂以过度设计否决：成员登出即关闭单实例既符合需求，也符合 S6"非活跃即零进程"目标；多浏览器 session 共享单实例可在证明有破坏时再议。

## Consequences

成员登出即回收其实例，空闲超过 `TEAM_IDLE_TIMEOUT_SECS` 的成员在下一次扫描时被回收并在下次登录时冷启动。proxy 保持无 Redis 依赖。按需冷启动（route 返回 `instance: null` 时触发 spawn）有意暂未实现：无实例的 session 仍显示 not-ready 页，并在下次登录时经 `ensure` 拉起。扫描定时器已 unref，绝不阻止进程退出；`stopAll` 在关闭时清除它。
