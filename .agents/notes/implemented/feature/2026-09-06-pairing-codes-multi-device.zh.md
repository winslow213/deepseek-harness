# Agent Note: 配对码与多设备挂载

Status: implemented

[English](2026-09-06-pairing-codes-multi-device.md) | 中文

## 问题

成员无法从 dsh web UI 签发配对码，挂载代码主机需要运维侧用 `dsh-shell remote pair` 并持有成员的 agent token。hub 还强制「一个用户一个 agent」（`byUser` 会踢掉旧 socket），且配对码是一次性的，因此单个成员无法挂载多台设备的 workspace。hub 的静态 `--user-token` 表与账号库中权威的 `agent_token` 出现了漂移。

## 决策

账号服务拥有配对码。`POST /api/pairings`（会话鉴权，与 `/api/me` 一样经 proxy）在 Redis 中签发配对码（`dsh-pairing:<uuid>`，TTL 30 分钟，`TEAM_PAIRING_TTL_SECS`），只返回 `{uuid, user, expiresAt, ttlMs}`——绝不返回 agent token。hub 通过调用 `POST /api/pairings/claim`（loopback，运维密钥保护）核实认领的码，该接口返回成员的 `agent_token`；hub 随后绑定该 agent、把该 token 作为重连 token 下发，并学习进自己的 token 表，使后续 `--user/--token` 重连可用。

配对码在 TTL 内可复用：claim 路径不删除 Redis key。hub 现在为每个用户登记多个 agent（`byUser` 变为列表；相同 agent id 仍替换自身），且 `exec`/`fs`/`fs-read`/`kill` 接受可选 `agentId` 消歧——多个 agent 在线时省略则返回 409。region-router 文件系统与 region-shell 执行器从影子路径透传所属 agent id。

浏览器行位于 `packages/client/ui-team-account`，与「退出登录」行并列：它向同源 `/api/pairings` 发 POST，然后展示配对码、认领命令（`dsh-shell remote agent --pair <uuid> --hub <host>:7101 …`）与复制控件。

## 曾考虑的替代方案

**hub 签发配对码：账号服务把码推入 hub 的 `/api/pairings`。** 拒绝，因为该端点验证 agent token 且把 hub 的静态 token 表当作签发权威，无法消除 DB/hub 的 token 漂移，且 hub 的内存 map 仍隐含一次性语义。

**每设备一次性码。** 拒绝，因为「一个码挂载多台设备」需要在 TTL 内复用；首台设备用完后报「码已用」会迫使成员为每台额外设备再回 web 签发。

**host 配对 remote（浏览器 → host → 账号 → hub）。** 拒绝，属于过度抽象：账号服务已可像 `/api/me` 一样经 proxy 访问，host 的 `pairing.mint()` remote 加 `config.user` 注入只会增加表面，而没有比直接 proxy 路径省掉任何信任（两种方式 agent token 都不进浏览器）。

## 后果

agent token 保持服务端到服务端（hub ↔ 账号）。一个码可在 TTL 内挂载多台设备。hub 在认领时学习 token，为已配对用户补齐了 S3 静态 token 缺口，而无需启动时加载 DB。此前按 `user` 寻址单 agent 的调用方，在多个 agent 在线时现在必须传 `agentId`；hub 返回 409 而非猜测。remote agent 保持零依赖。
