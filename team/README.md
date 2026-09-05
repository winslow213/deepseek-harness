# dsh Team Account Service

账号服务：为 dsh Team Shell 提供成员账号、登录会话与 agent token 签发。
独立于 pnpm workspace（与 `shell/` 同策略），自带依赖，作为服务器侧进程运行。
设计见 `../shell/team-access-design.md`。

## 运行

```sh
cd team
npm install
# 环境变量
TEAM_DB_URL=postgresql://postgres:13095758@127.0.0.1:5432/postgres \
TEAM_REDIS_URL=redis://127.0.0.1:6380/0 \
npm start
```

监听 `127.0.0.1:<port>`（默认 3900，`TEAM_HTTP_PORT` 覆盖）。

## CLI（operator）

- `npm run cli -- create-user <username> <password>` — 创建成员
- `npm run cli -- list-users`
- `npm run cli -- reset-agent-token <username>`
