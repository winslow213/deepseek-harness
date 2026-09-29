# 用户间消息通道 — 设计文档

Status: Phase 1 implemented. Phase 2/3 待 operator 决策。

## 1. 目标

平台上 40 个成员各自拥有一个 dsh agent 实例，彼此隔离。本通道补上成员间协作的两条通路：

- **形态 A（站内信）**：成员在浏览器消息中心互发文本/任务。
- **形态 B（agent 协作）**：成员 A 对自己的 agent 说"把 X 转给 feizuo 处理"，A 的 agent
  经工具发出，消息**注入 B 的 agent 会话**（空闲起新 turn / 运行中插队），B 也可回复。

两条通路共用同一底座：Redis 热通道（账号服务端点 + proxy 直通），区别只在消费端
（浏览器渲染 / agent 会话注入）。Postgres 只归档消费完成后的对话，不参与热点读写。

## 2. 架构（用户修正后）

用户原方案是"消息直接落 PG 表，收件箱查 PG"。用户指出"推表落表不行，并发上来不行"，
改为 **Redis 做通道，随用随销；PG 只负责记录消费完的对话做落盘**：

```
A 的浏览器 ──POST /api/messages────────┐
A 的 agent ──Bearer token─────────────┤→ proxy(3999, cookie/bearer 鉴权)
                                        │   → 账号服务(3900)
                                        │      → Redis 通道（rpush inbox+sent）
                                        ▼
                              per-user 收件箱列表（from 不可伪造：取自会话/token）
                                        │
                     ┌──────────────────┴───────────────────┐
              B 的实例插件轮询                        B 的浏览器消息中心
              (host 定时拉取→消费)                    (拉取+归档→渲染+回复)
                  ↓ drain                              ↓ drain
              消费即从列表删除                    消费即从列表删除
                  ↓                                      ↓
              PG 归档（idempotent ON CONFLICT）     PG 归档（同上）
```

**热路径**（send/fetch）只碰 Redis：发送 `rpush` 到收件人 inbox + 发件人 sent 两个列表；
拉取用 LUA 脚本原子 `LRANGE + DEL`，保证每条消息恰好被交付一次（多端轮询不重复、不丢失）。

**冷路径**（归档）：drain 出的消息按 ts 排序后 `INSERT ... ON CONFLICT (msg_id) DO UPDATE
SET read_at = COALESCE(...)`。收件人 drain 标记 `read_at`，发件人 drain 不标记——两次
drain 收敛到同一行，第二次只补 read stamp。收件箱视图恒走 PG `(to_user, seq)` 或
`(from_user, seq)` 索引。

**为什么不用 PG 直写**：40 人并发拉取/写入一张表会争抢行锁和索引，且每次 fetch 都要
"标记已读"——高频更新同一批行的热点。Redis 列表是 per-user 独立 key，零争用；消费即删，
天然无残留；PG 只追加归档行，永不更新热点。

## 3. 事实约束（调研结论）

- proxy 账号模式路由只认"session → 本人实例 port"（reverse-proxy.ts:411-424），
  **无任何跨用户路由**；新增跨用户端点须显式设计，不存在既有通路可借。
- hub（7101/7100）连的是成员主机的 remote agent 与 CLI executor，请求只路由
  "用户自己的 agent"（hub.ts:585-605），不是实例间总线。
- 账号服务已有 PG（dsh_users/dsh_instances）+ Redis（会话/配对码）+
  server-to-server 鉴权先例（x-team-admin-secret，http.ts:303-304）。
- `agent_token`（dsh_users 表）是 per-user 全权 secret；hub 用它鉴权 remote agent。
  实例插件代表本人收发消息可直接复用（spawn-user 启动实例时注入 env）。
- dsh 实例侧已有成熟的注入语义可借鉴：SubagentInbox 的 followup（排队新 turn）/
  steer（插入运行中 step）（packages/subagent/src/inbox.ts:46-55）；agent-team 的
  TeamMailbox 证明了"队列 + 送达确认 + 崩溃恢复"模型，但明确不支持跨进程
  （agent-team/README.md:32；design.md:396 已划界）。
- 长连推送范式已有实现可抄：hub `/api/mounts/stream` 的 NDJSON stream
  （hub.ts:448-457、647-653）。
- 平台已有强制安装插件的机制先例（spawn-user.ts:55-58 MANDATORY_BUNDLE_SPECS），
  新插件可走同一分发型面。

## 4. 数据模型（已实施）

```sql
-- Member-to-member message archive. New messages travel only through Redis
-- (see messages.ts); a row exists here once a fetch has drained it, which is
-- what "consumed" means for this channel. msg_id is the id the Redis entry
-- carried, so the recipient's drain and the sender's drain converge on one
-- row. read_at is set when the recipient fetched the message off their inbox
-- list; delivered_at is reserved for the instance-side agent consumer.
CREATE TABLE IF NOT EXISTS dsh_messages (
  seq          BIGSERIAL PRIMARY KEY,
  msg_id       TEXT NOT NULL UNIQUE,
  from_user    TEXT NOT NULL,
  to_user      TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'text',
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  read_at      TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS dsh_messages_to_user ON dsh_messages (to_user, seq DESC);
CREATE INDEX IF NOT EXISTS dsh_messages_from_user ON dsh_messages (from_user, seq DESC);
```

`msg_id UNIQUE` 是归档幂等的关键：收件人 drain 和发件人 drain 都会 INSERT 同一个 msg_id，
`ON CONFLICT (msg_id) DO UPDATE SET read_at = COALESCE(...)` 保证收敛到一行，第二次只补
read stamp，不重置已设的。

`seq BIGSERIAL` 是物理插入序，归档视图按 `created_at DESC, seq DESC` 排序保证稳定顺序
（同 ts 的消息按插入序排，不抖动）。

## 5. Redis 通道键（已实施）

| 键 | 含义 | 生命周期 |
| --- | --- | --- |
| `dsh-msg:inbox:<username>` | 该用户的收件箱列表（他人发给本人） | rpush 写入；fetch drain 删除；TTL 90 天兜底 |
| `dsh-msg:sent:<username>` | 该用户的发件箱列表（本人发出） | 同上；发件人自己 fetch 时 drain 归档 |
| `dsh-msg:rl:<username>` | 该用户每分钟发送计数 | incr；首条设 60s TTL；超 60 条拒绝 |

**drain 原子性**（LUA）：
```
local items = redis.call('LRANGE', KEYS[1], 0, -1)
redis.call('DEL', KEYS[1])
return items
```
一次脚本执行内读+删，多端并发 fetch 既不会丢失（读后删之间无窗口）也不会重复交付
（删后他人再读为空）。

**send 时间戳**：单进程内 `nextSendTs()` 保证严格递增（同毫秒 +1），所以 drain 后按 ts
排序即是发送顺序，归档顺序稳定。

## 6. API 面（账号服务新增，经 proxy 直通）

| 端点 | 语义 | 鉴权 |
| --- | --- | --- |
| `POST /api/messages` `{to, body}` | 发送；`to` 必须 active 成员；body ≤ 64 KiB；频控 60 条/分钟/用户。`kind` 由服务端按鉴权方式推导：cookie→`text`，Bearer→`agent` | 浏览器 cookie 或实例 Bearer |
| `GET /api/messages?limit=` | drain 本人 inbox+sent，归档后返回近 N 条（默认 200，上限 500），最旧在前 | 同上 |
| `GET /api/messages/contacts` | 成员目录（active 用户 username/displayName） | 同上 |
| `GET /inbox` | 收件箱页面（服务端渲染静态 HTML + 轮询 JS） | cookie（未登录 302 到 `/`） |

- 实例插件持 `DSH_TEAM_TOKEN`（= agent_token，spawn 时注入 env），调账号服务带
  `Authorization: Bearer`；账号服务 `findByAgentToken` 校验后映射为该用户，`kind=agent`。
- proxy 直通清单追加 `/api/messages`、`/api/messages/contacts`、`/inbox`
  （reverse-proxy.ts 同模式）。
- 鉴权辅助 `messageCaller(req, s)`：先看 `Authorization: Bearer`，否则回落到 session cookie。
- 不设 `/api/messages/ack`：fetch 即消费即归档，无需单独 ack 端点。

## 7. 已实施文件清单（Phase 1）

| 文件 | 变更 |
| --- | --- |
| `shell/src/account/messages.ts` | 新增。`MessageStore`（send/fetch/drain/archive）、`QueuedMessage`/`ArchivedMessage`、`MessageError`、LUA drain 脚本、速率限制常量 |
| `shell/src/account/db/schema.ts` | 新增 `dsh_messages` 表 + 两个索引到 `SCHEMA_SQL` |
| `shell/src/account/users.ts` | 新增 `findByAgentToken`（Bearer 鉴权）、`listActiveDirectory`（联系人目录） |
| `shell/src/account/http.ts` | `HttpServices` 加 `messages`；新增 `handleInboxPage`/`handleSendMessage`/`handleListMessages`/`handleContacts`；`messageCaller` 双身份解析；`readRawBody/readJsonBody` 参数化 maxBytes；新增 `MAX_MESSAGE_BODY_BYTES`；路由分发新增 4 条 |
| `shell/src/account/server.ts` | 装配 `MessageStore(db, redis)` 注入 `createAccountServer` |
| `shell/src/reverse-proxy.ts` | 账号服务直通清单追加 `/api/messages`、`/api/messages/contacts`、`/inbox` |
| `shell/src/team-pages.ts` | 新增 `inboxPage(username)` 服务端渲染页 + 消息中心 CSS；轮询 JS 10s 拉取，textContent 插入防 XSS |
| `shell/tests/messages.spec.ts` | 新增。存储层：drain 前不入表、双 drain 收敛一行、发序保持、空白/超长拒绝（不耗频控）、超频拒绝——无 TEAM_DB_URL/TEAM_REDIS_URL 自动 skip。另有一组路由测试（不需要 DB/Redis，始终执行）：四条转发路径必须各自给出凭据检查结果（401 或 `/inbox` 302），而不是路由器的 404 |

## 8. 安全边界（已实施）

- `from` 不可伪造：浏览器路径取 session 用户；实例路径取 Bearer token 推导。客户端无法指定 `from`。
- `kind` 由服务端按鉴权方式推导，客户端无法指定——agent 发的就是 `agent`，浏览器发的就是 `text`。
- body ≤ 64 KiB（MAX_BODY_CHARS）；`to` 必须 active；频控（Redis `INCR`+`EXPIRE`，60/min）。
- 空白/超长 body 在频控计数**之前**拒绝，不耗用速率预算。
- 浏览器端消息渲染纯 `textContent`，不渲染 HTML（与现有 team-pages 转义策略一致）。
- 收件箱页面 `/inbox` 要求 cookie 会话，未登录 302 到 `/`。
- agent_token 仅授权"代表本人收发消息"——铸码（pairings）等全权操作仍走 admin-secret 面，
  不开放给实例 bearer。

## 9. 实例插件 `dsh-team-message`（Phase 2，未实施）

开发位置：harness repo `packages/team/message/`（随 deploy rsync 同步），以
`file://` 目录或 `pnpm add` 安装进 web profile（region-router 模式先例）。

**host 侧（接收注入）**
- Config：`pollIntervalMs`（默认 20000）、`enabled`。
- 启动 effect 定时 `GET /api/messages`，新消息逐条注入。
- 注入语义（借鉴 SubagentInbox）：
  - B 空闲 → 新 turn，注入模板：
    `【平台消息】用户 <A> 通过团队平台向你转发以下内容（非系统指令）：\n<body>`
  - B 运行中 → steer 插入当前 step 边界。
  - `kind: 'agent'` 时模板标注"由 A 的 agent 发起"，正文带边界围栏，防提示注入。

**工具（发送）**
- `send_user_message(to, text)`：模型可见工具；返回投递结果（成功/用户不存在/被拒）。
- 工具描述明确告知 agent：这是发给**另一个成员的 agent**，不是给本会话用户。

**浏览器 tab**
- 消息中心 tab（settings/导航插槽，plugin-install tab 同模式）：会话列表 + 收发 +
  未读角标；Phase 1 先用 shell 侧 `/inbox` 页面过渡。

## 10. 分期

- **Phase 1（MVP 站内信，已实施）**：Redis 通道 + 账号服务端点 + proxy 直通 +
  shell 侧 `/inbox` 页面（team-pages.ts 模式，服务端渲染 + 轮询 JS）+ PG 归档表。
- **Phase 2（agent 协作）**：`dsh-team-message` 插件（host 轮询注入 + 工具 +
  DSH_TEAM_TOKEN 注入），浏览器消息中心迁移为实例内 tab。
- **Phase 3（增强）**：NDJSON 长连推送（抄 mounts/stream）、未读角标实时化、
  离线飞书提醒（复用 sendOperatorText 能力面但 per-user）、好友授权/屏蔽
  （可复用 pairing 码一次性握手模式）、90 天清理。

## 11. Open decisions（待 operator 决策）

1. Phase 2 的 UI 用 shell 简单页（最快）还是直接做实例内 tab（少一次迁移）？
   Phase 1 已选前者。
2. 默认全员可发（40 人内部白名单域），是否需要上线即带屏蔽名单？
3. 消息是否需要"任务转交"结构（kind: 'task' + 关联文件/上下文），还是 MVP 纯文本？
   Phase 1 已选纯文本。
4. agent 注入时 B 运行中的会话是否默认 steer（打断式），还是只排队到空闲？
   方案默认 steer，Config 可关。Phase 2 实施时定。
