# Agent Note：成员间消息通道：Redis 做传输、Postgres 只做归档

Status: implemented

[English](2026-09-20-team-member-message-channel.md) | 中文

## Problem

team-shell 部署里每个成员各自拥有一个互相隔离的 `dsh` 实例，而成员之间没有任何通路可以传消息：反向代理的账号模式只把浏览器会话映射到该成员自己的实例端口，hub 也只路由到成员自己的 agent。把工作转交给同事完全没有路径，浏览器上也没有任何界面能显示当前会话主人以外的人发来的消息。

## Decision

该能力由账号服务承担，`MessageStore`（`shell/src/account/messages.ts`）把它拆到两个存储上：Redis 是承载未投递消息的传输，Postgres 只归档已被 fetch 消费掉的内容。

一次发送会把一条 JSON 条目写入两个 per-user Redis 列表——收件人的收件箱 `dsh-msg:inbox:<user>` 和发件人自己的发件箱 `dsh-msg:sent:<user>`——两者都带 90 天 TTL。一次 fetch 会 drain 调用者的这两个列表，把 drain 出来的条目按发送顺序归档，并返回覆盖调用者所在全部会话的近期归档视图；发件箱存在的意义是：即使收件人从不 fetch，这条消息也已被归档。

drain 是一个在一次执行内完成 `LRANGE` 与 `DEL` 的 LUA 脚本（`DRAIN_LUA`），因此两次重叠的 fetch 既不会在"读取"与"删除"之间的窗口里丢失消息，也不会把同一条消息投递两次。

归档按消息 id 幂等：`dsh_messages.msg_id` 是 `UNIQUE`，插入语句是 `ON CONFLICT (msg_id) DO UPDATE SET read_at = COALESCE(dsh_messages.read_at, EXCLUDED.read_at)`。写已读时间戳的是收件人的 drain，发件人的 drain 归档时不带该戳，两者中后执行的一方只会补上前一方留空的时间戳——因此双方收敛到同一行，且不会把已读状态改回未读。

`nextSendTs()` 让发送顺序等于时间戳顺序：所有发送都由同一个账号服务进程写入，该值严格递增（同一毫秒内 `+1`），因此按 `created_at DESC, seq DESC` 排序的视图在时间戳相同的多条消息之间也是稳定的。

## HTTP surface

账号服务上有四条路径承载该能力，反向代理把它们直接转发到账号服务，因此永远不会路由到成员实例：

- `POST /api/messages`，请求体为 `{to, body}` —— 发送。收件人必须是 active 账号。
- `GET /api/messages?limit=` —— drain 并返回调用者的近期消息（默认 200，上限 500），最旧在前。
- `GET /api/messages/contacts` —— 供收件人选择器使用的 active 成员目录。
- `GET /inbox` —— 消息中心页面；没有会话的请求会被重定向到 `/`。

四条路径共用一个调用者解析函数：`messageCaller` 先用 `Authorization: Bearer` 头去比对 `dsh_users.agent_token`（`UserStore.findByAgentToken`），命中则给出 `kind: 'agent'`；否则回落到会话 cookie 并给出 `kind: 'text'`。因此发件人身份与 `kind` 都从凭据推导，绝不接受请求体传入，客户端无法冒充他人或冒充 agent。

发送在以下情况被拒绝：正文为空或超过 `MAX_BODY_CHARS`（65536）字符——这两项在频控计数自增之前检查；以及发送者在当前分钟内已超过 `SENDS_PER_MINUTE`（60）条，计数由 Redis 对 `dsh-msg:rl:<user>` 做 `INCR` 并设 60 秒 `EXPIRE`。发送端点同时把请求体上限提高到 `MAX_MESSAGE_BODY_BYTES`（256 KiB），因为一条被接受的消文在编码后会超过通用的 16 KiB 请求上限。

## Browser surface

`inboxPage`（`shell/src/team-pages.ts`）把消息中心渲染成一个自包含文档：按最近活跃排序的联系人侧栏、消息线面板和输入框，通过每 10 秒轮询 API 刷新。所有动态值都用 `textContent` 插入，因此消息正文不可能作为 HTML 渲染。

设置入口位于 `@deepseek-ai/dsh-client-ui-team-account` 包，是 General 分组下的一行（`team-message-center`，order 98），与既有的生成配对码、保持实例常驻、退出登录行并列。它在新标签页打开 `/inbox`，因此当前所在会话不受影响；它的渲染门槛与那些行一致，都要求文档带有 `<meta name="team-shell">` 标记。

## Alternatives considered

**发送时直接把每条消息写进 Postgres 表。** 被否决：所有成员都通过同一张表读写时，发送与拉取会在同样的行和索引条目上争抢，且每次 fetch 都要把行标记为已读——这是对同一批记录的高频更新路径。per-user 的 Redis 键之间零争用，而"消费即删除"不会留下任何需要过期或对账的残留。

**在反向代理里加一条跨用户路由。** 被否决：代理的账号模式把会话映射到该成员自己的实例端口，在代理里加成员间路由等于在一个"向单个实例代理"的组件里塞入第二条无关的路由规则。账号服务本来就拥有身份与持久化，而代理本来也已经有固定的账号端点转发清单。

**单独加一个 `POST /api/messages/ack` 端点。** 被否决：一次 fetch 已经消费并归档了消息，再单独确认只会引入一个"已投递但未确认"状态，而没有任何东西需要它；已读时间戳正是由那次移除条目的 drain 写入的。

**把消息投递进收件人的实例，而不是（或不只是）收件箱。** 本阶段否决：注入到他人的实例涉及自己的注入语义与提示词边界问题，而浏览器这一半并不需要它。`dsh_messages.delivered_at` 保留给那个消费者。

**用 WebSocket 或服务端推送代替轮询。** 被否决：入口主机提供的自包含页面不建立长连接，而对一个消息并不要求低延迟的 40 人内部工具来说，10 秒轮询已经足够。

## Consequences

热路径完全不碰 Postgres，因此成员的消息流量不会在归档上争用，而一条被消费的消息会彻底离开 Redis——不存在需要去对账的未读状态。代价是归档成为唯一的持久历史：未被 drain 的条目 90 天后过期，从不 fetch 的成员会在那时丢失其收件箱条目，而浏览器最多晚 10 秒才知道有新消息，因为页面是轮询而不是被推送。

## Testing

`shell/tests/messages.spec.ts` 用真实 Redis 与 Postgres 覆盖存储层——drain 之前不入归档、两次 drain 收敛为一行、双向发送顺序保持、空白与超长正文被拒且不耗用速率预算、以及每分钟上限——当 `TEAM_DB_URL`/`TEAM_REDIS_URL` 未设置时自动跳过，因为这些目标是运营者本地的。它的第二个测试组钉住被转发的那四条路由：每条都必须给出自己的凭据检查结果（401，或 `/inbox` 的重定向），而不是路由器那句 `no route for` 的 404——缺少分发时返回的正是后者。

## Related

`shell/message-channel-design.md` 记录了设计、Phase 2 的 agent 间注入方案，以及仍待与运营者确定的选择。