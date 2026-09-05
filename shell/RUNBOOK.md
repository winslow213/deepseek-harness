# dsh Team Shell — 运行手册

> 本仓库的 dsh **一律以团队形式（team shell）运行**：每用户独立 DSH_HOME +
> 统一 proxy 入口 + hub（agent 桥）+ region-router 挂载。不单独起裸 web 实例。
> 本文件记录「怎么起、怎么停、当前实例、踩坑」。设计见 `design.md`，
> 逐命令可执行出处见 `README.md` Quick start 与 `src/bin.ts` usage。

## 拓扑（当前）

| 组件 | 端口 | 用户/路由 | 启动命令 |
| --- | --- | --- | --- |
| **proxy** 入口 | 3999 | 默认 `@alice:32001` | `node --import tsx/esm shell/src/bin.ts proxy 3999 @alice:32001` |
| **hub**（agent 桥） | 7101 agent / 7100 control | token `alice=topsecret` | `remote hub --user-token alice=topsecret --agent-port 7101 --control-port 7100 --no-auto-inject --shadow-root /tmp/dsh-shadow` |
| **alice 实例**（每用户 dsh web） | 32001 | `DSH_HOME=/home/winslow/.dsh-users/alice` | `spawn-user alice 32001`（见下） |

用户浏览/CLI 走 **proxy 3999**（默认上游 @alice:32001），不直连 32001。

## 启动/重启

### 每用户实例（spawn-user）

```sh
DSH_USERS_ROOT=/home/winslow/.dsh-users \
DSH_PLUGIN_INSTALL=true \
DSH_ENTRY_HOST=10.33.2.56 \
node --import tsx/esm shell/src/bin.ts spawn-user alice 32001
```

- `spawn-user` provision `$DSH_USERS_ROOT/<user>`（不存在则写 web profile manifest，
  存在则复用），然后以 `DSH_HOME=<该目录>` spawn
  `apps/cli/src/bin.ts --profile web --port <port> --no-open`。
- **LAN 访问必须设 `DSH_ENTRY_HOST=<proxy LAN IP>`**：spawn-user 会把它透传为
  `--trusted-host <IP>`，实例的 browser-trust fence 才接受 proxy 转发的非 loopback
  Host。否则浏览器经 LAN proxy 会被 fence 拒绝（HTTP 401/拦截）。
- 打印 `USER URL: http://127.0.0.1:<port>/?token=...`。
- **默认 supervised**：spawn-user 进入监督循环，子 dsh 带 `DSH_SUPERVISED=1`。
  实例内插件安装完成后会写 `.dsh-restart-requested` marker 并自退出，监督循环
  看到 marker 后自动同端口重启（新插件生效）。其它退出（崩溃、无 marker）或
  SIGINT（Ctrl-C → stop）则终止循环。要保留旧一次性行为加 `--once`。
- **前台进程**：SIGINT（Ctrl-C）→ stop（SIGTERM 子 dsh）。要后台长驻用
  `setsid ... &` / nohup，别裸 detach 丢日志。
- 每用户隔离：alice 的 DSH_HOME 在 `/home/winslow/.dsh-users/alice`
  （`DSH_USERS_ROOT=/home/winslow/.dsh-users`）。别再手写
  `--profile web --port 32001`（裸 `--profile web` 会掉进默认 `$HOME/.dsh`）。
- **WebUI 安装插件后自动重启**：host 的 plugin-install 在 `DSH_SUPERVISED=1` 时
  装完写 restart marker 并自退出；supervisor 看到后自动拉新代次。未 supervised
  的实例（`--once` 或手动裸跑）装完不退出。

## 访问方式（浏览器 / CLI）

- **入口（LAN IP）**：http://10.33.2.56:3999 —— proxy，默认上游 @alice:32001。
  实例只绑 loopback（32001 不可直连），浏览器一律走 proxy。
- 每用户实例 URL（本机回环）记录于 spawn 输出与 RUNBOOK。
- 改代码后要**重启 alice 实例**（spawn-user 同命令重跑）才加载新 lib。

## 挂载 Windows 本地目录（CLI，在 Windows 主机跑）

用户代码在 Windows 上，通过 remote-agent 拨号 hub，把自己的目录挂进 alice
实例的 workspace。三样东西在各自主机跑：

### 1. Linux 服务器：hub（已常驻）
```sh
node --import tsx/esm shell/src/bin.ts remote hub \
  --user-token alice=topsecret --agent-port 7101 --control-port 7100 \
  --no-auto-inject --shadow-root /tmp/dsh-shadow
```
`--agent-port`(默认 7101,agent 拨入)、`--control-port`(7100,loopback 控制 API)，
`--shadow-root` 与 region-router config 一致。**agent 端口绑 0.0.0.0**，Windows 可达。

### 2. Windows 主机：跑 agent 拨号
```powershell
# Windows 上，在 dsh 仓库根目录
node --import tsx/esm shell/src/bin.ts remote agent `
  --user alice --token topsecret --hub 10.33.2.56:7101 `
  --name alice-win --root "D:\work" --allow-command cmd
```
- `--root D:\work` 是要挂载的本地目录（可重复 `--root` 挂多个）
- `--token` 必须与 hub `--user-token alice=...` 相同
- **挂载后**：alice 的 mount-sync 会把它注册成 workspace（标题形如 `↗ work (alice-win)`），
  经 region-router 把 shadow 树转回 Windows。模型/工具经 ctx.fs 访问 `D:\work`。
- 只跑文件操作可不 `--allow-command`；要让 dsh shell 工具跑命令需白名单 `cmd`。
- agent 零第三方依赖（node 内置 + shell/src/remote），可在任意目录起。

### 3. 验证挂载（服务器侧 / 任意能到 hub 的机器）
```sh
node --import tsx/esm shell/src/bin.ts remote agents   # 列出在线 agent
node --import tsx/esm shell/src/bin.ts remote mounts   # 列出可挂载根 (→ shadow)
```
alice 实例里出现该 workspace（标题含 `↗`）即挂载成功。

### 停止旧实例换新代码

1. `kill <dsh web PID>`（子进程，`apps/cli/src/bin.ts --profile web --port 32001`），
   不要 pkill（本环境禁）。
2. 确认端口释放：`ss -tln | grep 32001`。
3. 用上面 spawn-user 命令重启（同一 DSH_HOME，复用现有 profile 的 region patch）。

### proxy / hub 常驻

两个都是长驻 daemon（当前 PID 记录于本表/ps）。改 shell 代码后需重启它们才生效：
- proxy：kill 后同命令重启。
- hub：kill 后同命令重启（`--user-token` 必须与 agent/CLI 一致；`--shadow-root`
  与 region-router config 一致）。

## 已验证（2026-09-05）

- alice 32001 以新代码 + `DSH_PLUGIN_INSTALL=true` + `DSH_ENTRY_HOST=10.33.2.56`
  （→ `--trusted-host`）运行。
- **LAN IP 访问通**：`curl http://10.33.2.56:3999/?token=...` → 303（proxy 转发正常，
  browser-trust fence 接受 IP Host）。IP:32001 直连不可达（实例只绑 loopback，属预期）。
- 修复了 plugin-install npm-bundle 两个失败根因，见下节。

## 踩坑：plugin-install `pnpm add` 退出 1

**现象**：WebUI Install plugin 报
`plugin-install/pnpm-failed: pnpm add exited 1 in profile directory ...`，
输出含 `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: node-pty@1.1.0`。

**根因 1（代码，已自愈）**：pnpm ≥10 对**缺 `allowBuilds` 映射**的 profile，首次
`pnpm add` 撞上带原生 build 的依赖（如 node-pty）时，会**自动生成含无效占位**
`allowBuilds: { node-pty: set this to true or false }` 的 pnpm-workspace.yaml
并 exit 1 —— 此后每次重跑读到占位仍失败，需人工改成 `true`。
WebUI 安装现在**自动解析 `ERR_PNPM_IGNORED_BUILDS` 里被拒的包名，
写 `allowBuilds.<name>: true`（替换占位/保留文件其余字节）并重试一次**。
改 src 后必须 `pnpm run build:lib` 再重启实例。
历史：曾用 `stdio: inherit` 看不到报错 → 已改捕获输出；现在报错会带 pnpm 原因。

**根因 2（历史，已修）**：pnpm 报错曾只进服务器日志（`stdio: inherit`）。
现捕获 stdout/stderr，截断 2k 塞进 `plugin-install/pnpm-failed` 的
message + `details.output`。

## 本次产物状态

- shell 部署拓扑三个进程运行中（proxy / hub / alice 32001）。
- alice 32001 带 `DSH_PLUGIN_INSTALL=true` + `--trusted-host 10.33.2.56` + 自愈 lib。
- 残留单机 3080 已停；以后只跑团队形式。
