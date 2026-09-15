# Agent Note: region-router 挂载缓存改为订阅 hub 的推送通道

Status: implemented

[English](2026-09-15-region-router-stale-mount-cache.md) | 中文

## 问题

`RegionRouterFileSystem`（`shell/src/remote/region-router.ts`）会缓存 hub 的挂载表（`mountsCache`），且只在某个影子路径翻译失败时（`remoteOf(path) === undefined`）才重新拉取。一个挂载的影子目录（`shadowPathFor`，`shell/src/remote/hub.ts`）只由 `user` + `agentId` + 序号决定——从不依赖配对时的 `--root` 值。因此，当一个 Windows agent 用同一个 `agentId` 但不同的 `--root` 重新连接时（常见场景：重新配对到一个新的子目录，或重启后重新配对），它的影子路径不变，旧的缓存条目仍能翻译成功。刷新条件永远不会触发，router 会一直用旧的 root 转发请求——直到进程重启——一旦某个请求需要的路径只在新 root 下合法，agent 侧就会报 `path outside allowed roots: <旧 root>`。

## 决策

hub（`shell/src/remote/hub.ts`）现在暴露 `GET /api/mounts/stream`：一条长连接的 NDJSON 流，立即写入当前挂载表，此后每当有事件真正改变了挂载表——agent 连接/配对成功（在 `authenticate()` 内部，紧跟 `byAgentId.set(...)` 之后）、agent 断线（在 socket 的 `'close'` 处理里，紧跟 `byAgentId.delete(...)` 之后）——就再写入一次最新的表。`client.ts` 新增 `subscribeMounts(hubBase, onChange)`，打开这条流，一旦断开就按固定延迟重连。`RegionRouterFileSystem` 把原先的后台定时器换成一个 `ctx.effect()` 作用域内的 `subscribeMounts()` 调用，每收到一行推送就直接写入 `mountsCache`；`refreshMounts()` 仍然在构造时跑一次，作为流的第一条消息到达之前的快速兜底，`refreshFor()` 也保留原有的兜底逻辑（某个影子路径翻译失败时立即重新拉取），用于覆盖 router 在任何推送到达之前就先观察到翻译失败的情况。

## 备选方案

### 为什么不用后台轮询（这次修复的上一个版本）？

早先的一个版本按固定间隔轮询 `GET /api/mounts`（`ctx.effect()` + `setInterval`，默认 3 秒），照搬了 `mount-sync.ts` 已有的模式。它能生效，但不管挂载表有没有变化，每个已连接的实例都会在每次 tick 上消耗 CPU 和一次 hub 往返。hub 其实精确知道挂载表会变化的那两个时刻——agent 的 socket 打开或关闭——所以直接从这两处推送，比定时采样更精确、也更省。

### 为什么不让 hub 通过 `InstanceManager` 推送失效（杀掉再冷启动）？

一个更早的设计考虑过通过 `InstanceManager` 停掉正在运行的 per-user dsh 实例、让它带着全新缓存冷启动来触达它——但这会为了刷新一个文件系统插件的缓存，把用户当前活跃的浏览器会话（打开的标签页、正在进行的请求）直接打断。流式订阅的设计完全避开了这一点：这条推送通道只是 `region-router.ts` 到 hub 现有控制服务器之间的一条普通 HTTP 连接，跟 account 服务和 `InstanceManager` 完全无关；不会打断任何会话。

### 为什么不在每次访问影子路径时都重新拉取？

那会让挂载路径上的每个 fs 操作都产生一次 hub 往返，而 root 中途变更这种情况相对于一个会话内的文件读取频率而言是罕见的。推送订阅在不产生每次操作开销的前提下就能给出即时的新鲜度。

## 后果

- 给一个已连接的 agent（或同一台物理机器）用不同的 `--root` 重新配对后，该实例的 region-router 会在 hub 的 socket 处理逻辑观察到重连的那一刻立即生效——没有轮询间隔，也不需要重启实例。
- agent 断线也会推送一份最新的（此时该 agent 已消失的）挂载表，所以一个失效的连接也不会残留在 `mountsCache` 里。
- 挂载流连接是每个正在运行的 region-router 实例对 hub 控制服务器的一条常驻 HTTP 请求；hub 的 `close()` 必须先结束每一个仍然打开的订阅者响应，再关闭控制服务器，因为 Node 的 `http.Server.close()` 会等待现有连接结束。
- 回归测试覆盖：`shell/tests/region-router.spec.ts` 起了一个提供 `/api/mounts/stream` 的假 hub，直接通过这条流推送一个重新配对的 root（没有任何定时器），断言推送的那一行到达后 router 下一次远程 fs 调用会立刻使用新的 root。
