# Team Access — 设计文档（方案稿）

> 目标：把当前"operator 手动 spawn + 静态 URL"的 shell 提升为**成员自助接入的团队服务**：
> 成员经公共入口用账号密码登录 → 获得 token → 反代进入分配给他的 dsh 页面；
> 页面内提供"生成配对码"按钮，成员在自己的主机上 `remote agent --pair` 认领，把本机挂进自己的实例。
>
> 本文件为**方案定稿**，待 operator 确认后进入实现。实现完成后事实回写本文件（执行过的
> 命令/端口/表结构以实测为准）。

## 1. 拓扑（修正后）

```
服务器（Linux，部署 shell 服务面）
  proxy       入口聚合 3999（会话路由 + 反代 + WebSocket upgrade）      [reverse-proxy.ts]
  hub         agent 桥 7101/7100（token 鉴权 + 配对 + exec/fs 中继）  [hub.ts]
  supervise   每用户 dsh web 实例（由账号服务按登录拉起）                 [spawn-user.ts]
  账号服务    登录/成员/签发 token/实例生命周期的独立 node 服务          [★ 新增]
  Postgres    账号/users 表 + user→port 实例登记                       [本机 5432]
  Redis       登录会话（session_id → user_id, TTL）                   [本机 6380/15]

成员主机（Windows/Linux，跑 client CLI）
  remote agent --user <u> --token <agent_token> | --pair <code>       [面向用户交付]
  exec/cat/mounts 等 CLI 探测
```

- **client CLI 与 server 服务分离边界**（本阶段仅架构分离，独立交付包后置）：
  服务器不向成员分发 `shell/src/bin.ts` 全家桶；成员只见 agent 拨号命令与其
  `--root`/`--allow-command`/`--pair` 参数面。
- shell/ 服务面零依赖约束**不适用于账号服务**：账号服务依赖 `pg` + redis 客户端，
  以独立目录交付，不进 pnpm workspace（与 shell/ 同策略：upstream merge 零冲突）。

## 2. 账号体系

### 2.1 用户故事

1. 新成员由 operator 在服务器侧创建账号（用户名 + 初始密码，operator 分配）
2. 成员访问 `http://<server>:3999/` → 公共登录页
3. 成员输入用户名 + 密码 → 账号服务验证 → 发会话 cookie
4. 账号服务按登录用户分配端口并自动拉起该成员的 dsh 实例
5. proxy 按会话的 user 把请求路由到该成员的 dsh 实例
6. 成员在自己 dsh 页面点"生成配对码" → 得到一次性码
7. 成员在自己主机 `remote agent --pair <code> --hub <server>:7101 --root <dir>` → 挂载

### 2.2 数据模型（Postgres）

```sql
-- users：成员账号 + 该用户的 agent token（hub 拨号鉴权同源）
CREATE TABLE dsh_users (
  user_id      TEXT PRIMARY KEY,          -- 'alice'（也作 DSH_USERS_ROOT 子目录名）
  username     TEXT UNIQUE NOT NULL,      -- 登录名（首版与 user_id 同值，预留别名）
  display_name TEXT,
  role         TEXT NOT NULL DEFAULT 'member',  -- operator | member
  status       TEXT NOT NULL DEFAULT 'active',  -- active | disabled
  password_salt TEXT NOT NULL,            -- scrypt 随机 salt（node:crypto，hex）
  password_hash TEXT NOT NULL,            -- scrypt(password, salt) hex
  agent_token  TEXT NOT NULL,             -- 拨号 hub 的长期 secret（hub token 同源）
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- instances：user → 已 spawn 的 dsh 实例端口（supervise 启动时登记，停止时清除）
CREATE TABLE dsh_instances (
  user_id      TEXT PRIMARY KEY REFERENCES dsh_users(user_id),
  port         INTEGER NOT NULL,
  pid          INTEGER,
  launched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- 首版 `username == user_id`，避免独立"用户名→目录"映射。
- `agent_token` 为账号服务**签发**（`crypto.randomBytes(32).base64url`），hub 鉴权与
  配对都读这一份。
- scrypt：`crypto.scryptSync(password, salt, 64)` + timingSafeEqual 比较。零依赖。

### 2.3 登录会话（Redis）

- 登录成功 → `SET session:<random> user:<user_id> EX <ttl>`，回写 HttpOnly cookie。
- Redis 选 `6380/15`（与 hub/agent 不冲突；wiki-server 旧配置同库，弃用后复用）。
- ttl 默认 30 天（对齐 dsh browser cookie 生命周期），operator 可配。

## 3. 公共入口与反代路由

### 3.1 proxy 角色扩展

- 当前 proxy：静态 route map（`@alice:32001` 默认 / `user:port` 前缀），原样转发
  Host。**改造后**：
  1. 无会话 cookie → 响应登录页（静态 HTML + fetch 登录 API）。
  2. 有会话 cookie → 校验会话（查 Redis）→ 查 `dsh_instances` 拿该 user 的端口 →
     反代到 `<loopback>:<port>`；未知/未 spawn → 明确的"实例未就绪"页。
- 保持 `--trusted-host` 语义不变：实例以 proxy 入口 host 作为 trust authority，
  proxy 转发原 Host，浏览器 cookie 绑定入口 authority。

### 3.2 实例登记与自动拉起

- 登录成功后，账号服务在配置的端口范围内选择空闲端口，启动
  `TEAM_SHELL_COMMAND spawn-user <user> <port>`，并等待首代输出 URL 后写入
  `dsh_instances`（user→port）。
- 同一用户的并发登录共享一次启动操作；实例子进程退出时账号服务删除登记。
- `superviseUserInstance(user, port)` 在同一端口内负责插件安装后的重启；账号服务负责
  用户级实例的启动与停止。

### 3.3 登录 API（账号服务，走 loopback 由 proxy 反代或 proxy 直连）

- `POST /api/login` `{ username, password }` → 校验 → 建会话 → 设 cookie
- `POST /api/logout`
- `GET  /api/me`（会话 → 用户信息）
- 账号服务监听 loopback（如 127.0.0.1:3xxx），**只经 proxy 暴露**，同 hub control 一样不对外。

## 4. dsh 页面内配对按钮

### 4.1 形态（复用 plugin-install 已建立的 host+client 两包模式）

成员要在**自己的 dsh 页面**点"生成配对码"。浏览器 client 树只吃构建产物（host
`/plugins/<id>/client.js`），外部 file:// client 源码不被支持 → 需要**仓库内**
host remote 包 + client 包：

- host：新 `@deepseek-ai/dsh-host-pairing`（或并入 plugin-install 的宿主命名空间？——
  先独立包，语义清晰）。self-locate profile 目录 → 逆推 user（profile path 含
  DSH_HOME 段，或 profile patch 注入 `config.user` 同 region-router 的做法）。
  Remote 面：`pairing.mint()` → 返回一次性配对码 + 认领指令。
- client：新 settings tab / section，按钮触发 `ctx.remote.pairing.mint()`，展示码与
  认领命令（复制按钮）。
- 装配：web-app 组合里 operator 开关 + `config.user` 注入（supervise spawn 时按 user
  写 patch 或 env，实例自定位）。

### 4.2 mint 配对码的授权链（核心安全点）

- hub `POST /api/pairings` 目前要求 `{ user, secret }`（secret = agent_token）。
- 成员**不应在浏览器里持有 agent_token**。改为：
  1. client 页面按钮 → host `pairing.mint()`（进程内，已鉴权为被登录用户）
  2. host 服务持 `config.user`（supervise 注入）→ 向账号服务查询该用户
     `agent_token`（loopback、账号服务内网鉴权）→ 用它调 hub `/api/pairings` mint
     —— **token 只存在于服务端进程间**，永不进浏览器。
- 或 hub 增设一个受控 mint 通道：host pairing 服务持有一个"shell 服务令牌"（区别于
  用户 agent_token），hub 对持有该令牌的请求允许按 user mint —— 二选一，实现时定。

### 4.3 配对完成

- 成员主机 `remote agent --pair <code>` → hub 认领 → `onPaired` → auto-inject region
  router → 该实例 workspace 出现挂载区。此链已存在，零改动。

## 5. hub token 动态化

- 现状：`remote hub --user-token user=secret,...` 静态表。
- 改造：hub 启动时从账号服务/DB 读取 `users.agent_token` 建 `user→token` 表（快照，
  与现在的 `options.tokens` 同构）。agent 拨号 `hello {user, token}` 仍查这张内存表
  —— hub 内核对"动态/静态来源"无感。
- 账号服务创建用户 / 重置 token 后需触发 hub 重载（hub 提供 reload 端点或重启 hub；
  首版 operator 手动重启 hub 即可，文档写明）。

## 6. 进程与端口规划

| 服务 | 监听 | 说明 |
|---|---|---|
| proxy 入口 | 0.0.0.0:3999 | 唯一 LAN 入口 |
| hub agent | 0.0.0.0:7101 | agent 拨号 |
| hub control | 127.0.0.1:7100 | loopback 控制 API |
| 账号服务 | 127.0.0.1:3xxx | loopback，只经 proxy |
| dsh 实例 | 127.0.0.1:32001+ | 每用户一个，supervise |
| Postgres | 127.0.0.1:5432 | dsh_users / dsh_instances |
| Redis | 127.0.0.1:6380/15 | 登录会话 |

## 7. 安全边界（必须满足）

1. agent_token **永不**出现在浏览器（页面/网络请求/cookie）。
2. 账号服务只监听 loopback；登录/配对/me 全部经 proxy（LAN 入口）。
3. hub 配对 mint 仍要求服务端持有 secret；host pairing 服务到账号服务取 token 的
   调用带内网共享令牌或绑定 loopback + 进程白名单。
4. 会话 cookie：HttpOnly + SameSite=Strict + 绑定入口 authority（与 dsh browser cookie
   同策略）。
5. proxy 登录态与会话：Redis 会话被删（登出/过期）后 proxy 立即拒绝路由。
6. scrypt 参数取 OWASP 推荐（N=2^17, r=8, p=1）；每次登录 timingSafeEqual。
7. operator 角色才可建账号/重置 token（首版经服务器侧 CLI，不给 Web 管理面）。

## 8. 实施阶段

- **S1 账号服务**（独立目录，自带 deps）：users 表 + scrypt 注册/登录 + Redis 会话 +
  agent_token 签发；CLI（operator 建号/重置密码/重置 token）+ 冒烟测试（curl）。
- **S2 proxy 登录路由**：登录页 + 会话校验 + `dsh_instances` 查端口反代 + /api/me、
  logout；未登录/未分配状态页。
- **S3 hub token 动态化**：hub 从账号 DB 加载 token；agent 拨号回归测试。
- **S4 配对按钮（in-dsh-web）**：host pairing remote + client 包 + web-app 装配 +
  operator 开关 + config.user 注入；成员端 `agent --pair` 端到端验证。
- **S5 文档/runbook 更新 + 边界整理**：client CLI 目录与 server 目录分离。

### Operator 决策（2026-09-05，定稿）

| 决策 | 结论 |
|---|---|
| 账号服务位置 | ~~仓库根 `team/` 新目录~~（已合并，见下条） |
| hub token 更新 | **重启 hub** 生效（首版不加重载端点；文档写明流程） |
| 本次范围 | **S1 + S2**（账号服务 + proxy 登录路由）；S3/S4 配对与 hub 动态 token 下批 |
| Postgres 访问 | 实现时用 env 提供连接串（config 不落明文）；本机 5432 上库待 operator 给凭据 |
| 实例启动归属 | ~~账号服务分配端口并自动启动 `spawn-user`~~（已改为进程内 supervise，见下条） |

### Operator 决策（2026-09-06，合并）

账号服务与 shell 服务面功能重合（实例生命周期、实例登记、代理路由），已合并：
账号服务代码从仓库根 `team/` 移入 `shell/src/account/`，`shell/package.json` 增加
`pg` + `ioredis` 依赖（remote agent 仍零依赖）。入口为 `dsh-shell account`
（服务）与 `dsh-shell account-cli`（operator CLI）。实例启动改为**进程内 supervise**
（`instance-manager` 直接调用 `superviseUserInstance`，不再经 `spawn-user` 子进程 +
stdout `USER URL` 解析）。

## 9. 依赖的事实锚（已核实 2026-09-05）

- spawn-user 现支持 `superviseUserInstance`（DSH_SUPERVISED marker 重启），默认
  supervised（未提交改动中）；`--once` 保留一次性行为。
- dsh browser auth：`?token=` 为 per-process launch token（进程存活期可反复换 cookie，
  非一次性）；cookie 30 天、HttpOnly、SameSite=Strict、绑定 authority；`--trusted-host`
  放行非 loopback Host。proxy 转发原 Host 即满足实例 trust fence。
- hub `/api/pairings` mint 需 `{user, secret}`（secret = agent token），码 TTL 10 分钟、
  一次性；agent `--pair` 认领后 hub 下发该 user 真 token，重连用 `--user/token`。
- hub control API 无 HTTP 鉴权、只绑 loopback。
- 浏览器 client 树由 host Loader 的 `dsh.client` 行驱动，client bundle 需构建产物
  （`lib/client.js` 经 `/plugins/<id>/client.js` 伺服）；file:// client 源不支持。
- 实例不知道自己的 user id；region-router 通过 profile patch 注入 `config.user`。
- plugin-install 已建立 host（self-locate profile + operator 开关 + typert remote）+
  client（settings tab）完整模式，本方案 S4 复用。
- 本机 Postgres 127.0.0.1:5432、Redis 6380/15 均在跑（wiki-server 弃用后库可复用）。

## 10. 实例生命周期管理（S6：空闲回收 + 按需冷启动）

> 容量分析（2026-09-05 实测）驱动本阶段：**单机同时在线上限 ~70 常驻实例**（内存
> 39GiB 可用 ÷ 每实例 ~435MB：dsh web 360MB 实测 + supervisor 75MB）。空闲回收是
> 从 70 → 200 注册用户的关键。design 假设单实例 270MB 已过时（实测 360MB，含插件）。

### 目标形态（full-spawn-on-demand）

- 用户无活跃会话时**零进程**（supervisor + dsh web 一起回收，释放 ~435MB/用户）
- 用户经 proxy 访问 → 冷启动 spawn（~2-5s）→ 路由转发
- 空闲 N 分钟 → 回收。**端口经 account 分配**(可复用),DSH_HOME 落盘保证会话恢复

### 实现要点（归 team 侧，依赖 team 已有 Postgres+Redis+ioredis）

1. **端口分配(account)**：新增 `POST /api/instances/allocate` → 从空闲端口池分配
   （或固定 user→port 映射），避免回收后冲突。实例登记已有 `upsert`。
2. **活跃追踪**：proxy 每次请求 → account `/api/touch`（记 redis `active:<user>` TTL）；
   proxy 保持无 redis 依赖（连 account HTTP API）。
3. **回收仲裁(account)**：定时扫描 redis 超时 key → 对对应 supervisor 发回收信号
   （redis pub/sub 频道 `dsh-reclaim:<user>`），落库 instance removed。
4. **spawn-user 订阅回收**：supervisor 订阅频道 → `stop()` + unregister + 退出；
   `unregisterInstance` 已存在。
5. **proxy 冷启动**：route 返回 `instance:null` 时（需 route 增返 user_id）→
   spawn `spawn-user <user> <port>` → 轮询 route 至就绪 → 转发。NOT_READY_PAGE
   保留为冷启动失败兜底。
6. **route 响应扩展**：`/api/session/route` 无实例时返回 `user_id`（proxy 才能 spawn），
   否则 proxy 无从知道为谁拉起。

### 待 team agent 决策

- 空闲判定时长 N（建议默认 15-30 分钟；与 Redis 会话 TTL 30 天解耦）
- 端口池范围（design §77：内部段 32768-60999 有 2.8 万个，瓶颈是内存非端口）
- 冷启动并发互斥（同一用户多请求同时触发 spawn → 需幂等/单飞）

### 实现现状（2026-09-06）

- **空闲回收已落地**（简化版）：`dsh_instances` 增 `last_seen_at` 列；proxy 每次
  `/api/session/route` 决策时 account 内联刷新该列（`InstanceStore.touch`，无需独立
  `/api/touch`，proxy 保持无 redis 依赖）；`InstanceManager` 每 60s 扫描
  `idleUsers(idleTimeoutSecs)` 并对空闲实例 `stop()`。阈值 `TEAM_IDLE_TIMEOUT_SECS`
  （默认 30 分钟）。
- **logout 主动回收已落地**：`/api/logout` 销毁 session 后 `lifecycle.stop(userId)`，
  回收 supervisor + dsh web。
- **冷启动（第 5/6 点）未实现**：route 返回 `instance:null` 时 proxy 仍只显示
  NOT_READY_PAGE，需在下次登录时由 account `ensure` 拉起。若要 full-spawn-on-demand，
  需按第 5/6 点扩展 route 响应并让 proxy 触发 spawn。
