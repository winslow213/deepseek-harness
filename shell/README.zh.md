# dsh Team Shell

[English](README.md) | 中文

`shell/` 是把 DeepSeek Harness 作为团队共享服务运行的控制面：为每个用户孵化一个隔离的 `dsh` web 实例，把实例聚合在单一入口之后，并把 shell 与文件系统操作桥接到各用户自己机器上的代码（Windows 同样支持）。本目录刻意独立：不进 pnpm workspace、不注册进根 tsconfig / package.json，上游 master 永不创建此目录，因此 `git rebase origin/master` 与本目录零冲突。设计记录见 [design.md](design.md)。

## 快速开始

每个用户都拥有独立的实例及其 DSH_HOME（settings、credentials、sessions 与工作区都保存在其中）。在 loopback 端口上孵化一个实例：

```sh
node --import tsx/esm shell/src/bin.ts spawn-user alice 32001
```

`spawn-user` 在 users 根目录（默认 `$TMPDIR/dsh-users`，可用 `DSH_USERS_ROOT` 覆盖）下预建该用户的 DSH_HOME，启动 `dsh --profile web`，并打印实例的带鉴权 URL，例如 `USER URL: http://127.0.0.1:32001/?token=...`。Ctrl-C 可停止实例。

## 远程执行桥

桥接服务的对象是每个用户自己的代码主机。该主机上的 agent 主动出站拨号 hub（方向 B：NAT 之后的主机无需入站端口）；hub 监听 agent 拨号端口并暴露 loopback HTTP 控制 API，per-user dsh 实例或 CLI 操作者经该 API 发出 exec 与文件请求。实现位于 `shell/src/remote/`：`hub.ts`、`agent.ts`、`client.ts`、`protocol.ts`、`executor.ts`（远程 ShellExecutor）、`fs-provider.ts`（远程 FileSystem）、`inject.ts`、`shadow.ts`、`region-router.ts`、`region-shell.ts` 与 `mount-sync.ts`。

### 启动 hub

为每个你会签发 agent token 的用户提供一个 `--user-token user=secret`，然后启动 hub：

```sh
node --import tsx/esm shell/src/bin.ts remote hub \
  --agent-port 7101 --control-port 7100 \
  --user-token alice=SECRET_A --user-token bob=SECRET_B
```

`--agent-port`（默认 7101，env `DSH_HUB_AGENT_PORT`）是 agent 拨入的监听口；`--control-port`（默认 7100，env `DSH_SHELL_CONTROL_PORT`）提供 loopback API（`/api/agents`、`/api/mounts`、`/api/pairings`、`/api/exec`、`/api/kill`、`/api/fs-read`、`/api/fs`）。hub 每 15 秒对每个 agent 心跳一次，逐出同一用户或同一 agent id 的过期/重复连接，并在 agent 通道断开时结束进行中的请求。`--shadow-root DIR` 可改变挂载影子目录树的位置（默认 `/var/lib/dsh-mounts`）；`--no-auto-inject` 关闭配对完成后的自动 provider 注入（见下文）。

### 在代码主机上运行 agent

agent 是最后防线：只执行 `--allow-command` 白名单内的命令名，并且它服务的每个路径都必须解析到某个 `--root` 目录之下（绝对路径逃逸与 `..` 上跳都会被拒绝）。在用户的 Linux 机器上启动一个：

```sh
node --import tsx/esm shell/src/bin.ts remote agent \
  --user alice --token SECRET_A --hub 10.33.2.56:7101 \
  --name alice-linux --root /home/alice/code \
  --allow-command cat --allow-command ls --allow-command git
```

`--root` 与 `--allow-command` 均可重复；`--name` 默认为 `<user>@<hostname>`；不提供任何 `--allow-command` 时所有 exec 都会被拒绝。守护进程在通道断开后以指数退避重连。把 shell 加入白名单（`bash`，Windows 上是 `cmd`）即有意授予该平台上任意命令执行权——这是对外提供 dsh shell 工具的文档化方式。

### Windows 代码主机

agent 平台无关，在用户的 Windows 机器上以同样方式运行。Windows 没有 bash：shell executor 根据它转发的工作目录选择 shell（`D:\...` 风格目录走 `cmd /c`，其余走 `bash -c`），因此 Windows agent 把 `cmd` 加入白名单即可对外提供任意 shell 命令：

```sh
node --import tsx/esm shell/src/bin.ts remote agent \
  --user alice --token SECRET_A --hub 10.33.2.56:7101 \
  --name alice-win --root D:\work --allow-command cmd
```

### 从服务器侧探测

从服务器验证连通性并探测 agent（以下命令都访问 loopback 控制 API）：

```sh
node --import tsx/esm shell/src/bin.ts remote agents --control-port 7100
node --import tsx/esm shell/src/bin.ts remote mounts --control-port 7100
node --import tsx/esm shell/src/bin.ts remote cat --control-port 7100 alice /home/alice/code/README.md
node --import tsx/esm shell/src/bin.ts remote exec --control-port 7100 alice git -C /home/alice/code status
```

`agents` 列出每个已连接 agent（user、远端地址、roots、允许的命令）；`mounts` 列出每个被服务 root 及其映射到的服务器侧影子路径（见下文 region router）；`cat` 经 agent 的 `fs:read` 流式读取一个文件；`exec` 让一个 argv 穿过 agent 的白名单执行。

### 用一次性配对码接入代码主机

配对码让新机器无需携带长效 secret 即可接入。先在服务器上为用户铸一个码（这一步证明你掌握该用户的 agent token）：

```sh
node --import tsx/esm shell/src/bin.ts remote pair \
  --user alice --secret SECRET_A --control-port 7100
```

打印出的 UUID 有效期为 10 分钟。在目标主机上认领它——无需 `--user`/`--token`：

```sh
node --import tsx/esm shell/src/bin.ts remote agent \
  --pair 3d7f0a2e-cd94-4f1b-8b6a-5c2e6f9a1b44 --hub 10.33.2.56:7101 \
  --root /home/alice/code --allow-command git
```

hub 消费该码，把 agent 绑定到码对应的用户，并在应答 agent 的 hello 时下发该用户的真实 token，因此之后的断线重连照常用 `--user`/`--token` 鉴权。自动注入默认开启：配对完成后 hub 随即为该用户的 profile 装配远程 provider；`--no-auto-inject` 让配对保持为纯注册。

### 把 per-user 实例指向它的 agent

`remote inject` 写入 profile patch，把 per-user 实例的本地 provider 换成指向该用户 agent 的远程 provider。它把 provider 运行时复制进 `<profile>/plugins/remote`，并写入 `cordis.patch.yml`（disable 掉 `bash-sandbox`、`pwsh-sandbox` 与 `fs-sandbox`，插入 `remote-shell` 与 `remote-fs`）：

```sh
node --import tsx/esm shell/src/bin.ts remote inject \
  --home /srv/dsh-users/alice --hub http://127.0.0.1:7100 \
  --user alice --cwd /home/alice/code
```

`--home` 是该用户的 DSH_HOME，其中的 `profiles/web` 目录会被打上 patch；`--cwd` 是远程工作目录（必须位于 agent 的 `--root` 之下）；`--sandbox-mode read-only|workspace-write|danger-full-access` 声明对该 root 的权限意图（默认 `workspace-write`）。此后模型的 bash 工具调用经 hub 抵达 agent，resolve/run/start、超时与 kill 语义与本地执行一致；要执行任意 shell 命令，agent 必须把 `bash`（POSIX）或 `cmd`（Windows）加入白名单。删除生成的 patch 文件即回退到本地 provider。

### 同一实例同时服务本地与挂载路径（region router）

一个实例可同时服务服务器自身授权的目录与所有已配对 agent 的挂载 root。形态 A 为每个 agent root 分配一个真实的服务器侧影子目录——`<shadow-root>/<user>/<agent>`（第二个 root 追加 `/root1`、`/root2`，……）——因为 dsh 的 workspace 模型要求真实、可 stat 的目录。绑定到影子路径的 workspace 就是覆盖远程 root 的 workspace：`mount-sync` 轮询 hub，把本实例的每个 mount 注册为 workspace（`↗ <dir> (<agent>)`）；region router 则把影子树下的每次访问翻译回所属 agent 的真实路径，并经 hub 转发。

router 扩展的是受沙箱保护的本地 provider：影子树之外的路径与工作目录保持完整本地语义；翻译后的工作目录以分隔符形式携带 agent 平台，因此 executor 在挂载的 `D:\...` 目录上执行 `cmd /c`，其余情况执行 `bash -c`。装配写入 `region-fs`、`region-shell`、`region-mount-sync` 三个 patch 行（被 disable 的本地行与 `remote inject` 相同）；`shell/src/remote/inject.ts` 的 `injectRegionRouter` 负责复制与写入 patch：

```sh
node --import tsx/esm --input-type=module -e "
import { injectRegionRouter } from './shell/src/remote/inject.ts'
injectRegionRouter({
  runtimeSourceDir: process.cwd() + '/shell/src/remote/',
  hubUrl: 'http://127.0.0.1:7100',
  user: 'alice',
  shadowRoot: '/var/lib/dsh-mounts',
  profileDir: '/srv/dsh-users/alice/profiles/web',
  includeShell: true,
  syncMounts: true,
})
"
```

## 反向代理聚合

`proxy` 把各 per-user 实例聚合到单一入口端口之后。`user:port` upstream 经 `/u/<user>` 提供；写成 `@user:port` 的 upstream 是默认路由，路径原样透传：

```sh
node --import tsx/esm shell/src/bin.ts proxy 3080 @alice:32001 alice:32002
```

HTTP 请求与 WebSocket 升级（dsh web 的 `/api/remote.mux` 通道）都会被代理到匹配的 upstream。账号模式使用 `node --import tsx/esm shell/src/bin.ts proxy 3999 --account http://127.0.0.1:3900`，账号服务在登录成功后于进程内监督每位用户的一个 dsh 实例并登记实例路由；proxy 只负责会话路由，不启动进程。详见[账号设计](team-access-design.md)。

## 账号服务

`account` 在 loopback 端口启动账号服务：成员账号、登录会话（Postgres + Redis）、agent token 签发，以及每位成员一个受监督的 dsh 实例。它是 shell 唯一需要第三方包（`pg`、`ioredis`）的表面；remote agent 仍保持零依赖。

```sh
cd shell
npm install
npm run account
```

`TEAM_DB_URL`（Postgres）与 `TEAM_REDIS_URL`（Redis）必填；复制 `.env.example` 为 `.env` 并填入。登录成功后，账号服务分配空闲 loopback 端口，在进程内监督该用户的 `dsh --profile web`，并登记 proxy 读取的实例路由。`DSH_USERS_ROOT` 与 `DSH_ENTRY_HOST` 控制生成的实例。

账号服务还签发多设备配对码：浏览器「生成配对码」设置行发 `POST /api/pairings`（会话鉴权，经 proxy），hub 通过 `POST /api/pairings/claim` 核实认领的码。用 `--account http://127.0.0.1:3900` 启动 hub，使其向账号服务（而非静态 `--user-token` 表）查询码并学习每位成员的 agent token；`TEAM_PAIRING_TTL_SECS` 设置码的有效期。

Operator CLI：

```sh
cd shell
node --import tsx/esm src/bin.ts account-cli create-user <username> <password> [--operator]
node --import tsx/esm src/bin.ts account-cli list-users
node --import tsx/esm src/bin.ts account-cli reset-agent-token <username>
node --import tsx/esm src/bin.ts account-cli reset-password <username> <password>
```

## 开发

独立 shell 可不依赖 workspace 单独类型检查；在 dsh 实例内部运行的模块（`executor.ts`、`fs-provider.ts` 以及 region-router/mount-sync 一族）引用 `@deepseek-ai/*` seam，须在仓库源图下检查：

```sh
npx tsc -p shell/tsconfig.json --noEmit
npx tsc -p shell/tsconfig.executor.json --noEmit
```

## 设计记录

[design.md](design.md) 记录了架构与里程碑：每用户 DSH_HOME 预置、反向代理聚合、远程桥设计（含 A/B settings 取舍）、region-router 影子目录形态，以及尚未实现的部分（agent 通道的 TLS、空闲回收与配对网页页）。
