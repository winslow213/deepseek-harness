# Agent Note: 受信主机进入浏览器特权面

Status: implemented

[English](2026-09-03-trusted-host-settings-surface.md) | 中文

## 问题

dsh web UI 把 settings 持久化与 file-open 放在仅限 loopback 的检查之后：浏览器特权面读取的 `ctx.connection.isLoopback` 由页面 URL 的 hostname 推导，因此当 Web GUI 服务范围超出 loopback（以全网卡绑定、通过 LAN IP 字面量访问）时，每个 settings 面都呈 terminal-unavailable（"settings are unavailable in this browser"），尽管 /api 浏览器信任围栏已通过 `trustedHosts` 放行同一权威。

## 决策

把浏览器特权面分类扩展为信任部署自身的 `trustedHosts` 列表——也就是 /api 围栏强制执行的同一份列表（[所有 /api 路由共用一道载体级浏览器信任边界](../architecture/2026-07-28-api-browser-trust-boundary.zh.md)）。Host connection 插件把 `trustedHosts` 以 index-injection global row 发布到页面（`globalThis.__DSH_TRUSTED_HOSTS__`，仅当列表非空时注入）；浏览器 connection client 在下列情况下把页面权威判为特权：页面为 loopback、transport 声明其拥有该 host、或页面 hostname 命中受信条目（无端口条目匹配任意端口）。能针对受信 Host 触达带鉴权 /api 通道的页面，正是围栏放行其 settings 请求的同一页面，因此该注入不引入任何新权威。

浏览器安全的 `isTrustedPageAuthority` 分类器（`packages/client/connection/src/trusted-hostname.ts`）镜像了 `packages/client/connection/src/api-request-trust.ts` 中 Host 侧 `isTrustedAuthority` 的条目语义。

## 曾考虑的替代方案

- **特权面保持仅限 loopback**——否决：Web GUI 超出 loopback 提供服务是受支持的部署形态（全网卡绑定时 /api 围栏会把无端口 LAN IP 字面量推导进 `trustedHosts`），因此页面侧的拒绝与围栏自相矛盾而非防护任何东西，并恰好让这些页面上的 settings 退化为内存只读、file-open 不可用。
- **在 shell 反向代理处做伪 loopback 映射**（[团队 shell 设计](../../../../shell/design.md) §7.6 的路线 B：改写页面 host，让浏览器看到 loopback hostname）——对本面否决：它只在那个代理之后生效，并且它掩盖真实页面权威而非声明它。路线 A——把受信列表扩展到浏览器面——之所以胜出，是因为每个 per-user 实例只服务单一用户，扩展后的信任风险可控。

## 后果

- 页面 hostname 命中配置或绑定推导出的 `trustedHosts` 条目时，settings 持久化与 file-open 现在与 loopback 页面表现一致；部署未列出的 hostname 仍保持 terminal-unavailable。
- 浏览器侧比较只按页面 hostname 匹配（client 构造分类 URL 时不带页面端口），因此显式 `host:port` 受信条目仍放行 /api 流量，但目前永远不会把页面判为特权；部署推导出的 LAN 服务形态是无端口的，可以命中。
- 注入的列表走既有 index-injection 通道，仅当 `trustedHosts` 非空时出现在页面；loopback 与 transport 拥有的页面无需任何条目。`assertTrustedAuthority` 仍在插件加载时拒绝非规范条目，因此页面只能看到围栏已经接受的条目。
- 本次改动不增加任何新的配置面：部署配置信任的方式与为 /api 围栏配置时完全一致，即 `trustedHosts`/`--trusted-host`。
