# Agent Note: 账号服务负责登录与实例拉起

Status: implemented

[English](2026-09-05-account-owned-instance-launch.md) | 中文

## 问题

Team proxy 可以认证成员并路由请求，但成员实例未启动时路由无法使用。手动启动实例把每次登录绑定到运维操作，也让账号服务不拥有已认证会话所依赖进程的生命周期。

## 决策

账号服务负责成员登录到实例的转换。`AuthService` 创建会话后，账号 HTTP handler 要求 `InstanceManager` 确保成员已有已登记的 dsh 实例。`InstanceManager` 从 `TEAM_INSTANCE_PORT_START` 到 `TEAM_INSTANCE_PORT_END` 分配未使用端口，并在进程内监督成员的实例（见[账号服务并入 shell](../simplification/2026-09-06-merge-account-service-into-shell.zh.md)）；它在等待第一代 URL 后才把端口、启动令牌和 PID 写入 `dsh_instances`。

`InstanceManager` 合并同一用户的并发启动请求，启动期间保留端口，监督循环结束时删除实例记录，并在账号服务关闭时停止所有由账号服务拥有的 supervisor。启动失败会销毁刚创建的会话并返回明确的 503。`spawn-user.ts` 仍负责准备 `DSH_HOME`，`superviseUserInstance` 负责插件安装后的同端口重启，现在由账号服务直接驱动而非经 `spawn-user` 子进程。proxy 只负责认证与路由，不负责启动实例。

部署通过 `TEAM_INSTANCE_PORT_START`/`TEAM_INSTANCE_PORT_END` 配置端口范围；`DSH_USERS_ROOT` 与 `DSH_ENTRY_HOST` 由 `spawn-user` 从共享环境读取。已有实例登记仍是权威状态，因此账号服务重启不会为仍在运行的实例重复拉起进程。

## 曾考虑的替代方案

**由 proxy 在缺少路由时启动实例。** 拒绝，因为 proxy 除了 HTTP 路由还要拥有进程、端口分配、启动协调和清理，并且登录成功会隐含依赖另一个组件的生命周期。

**保留运维启动实例并返回“实例未就绪”页面。** 拒绝，因为登录不能提供可用会话，每名成员还需要额外的运维动作。

**每次登录都启动新进程。** 拒绝，因为每名成员必须拥有一个隔离的 `DSH_HOME` 和一个持久实例路由；按用户的启动表与持久登记让并发登录保持幂等。

**登录响应先返回，再异步启动实例。** 拒绝，因为浏览器的首次路由会与实例登记竞争。等待 URL 能让调用者得到明确的成功或可处理的 503。

## 后果

账号服务部署必须提供足以容纳并发成员的端口范围。账号服务现在负责子进程清理，并把实例启动失败报告为登录失败。shell CLI 仍可用于手动操作，但正常的团队接入不再要求运维在成员登录前手动启动实例。
