# dsh Team Shell 设计文档

> 团队公用型 DeepSeek Harness 多租户服务的壳层设计。
> 本目录（`shell/`）刻意独立于 pnpm workspace 与上游目录树，保证 master 合并零摩擦。

## 1. 背景与目标

dsh（DeepSeek Harness）是单机单用户工具：一个进程 = 一个 DSH_HOME = 一份
settings/profile = 一个 loopback token。web UI 的安全模型假定"浏览器 = 本机
operator"：settings 持久化、文件打开等特权面仅在 loopback 可达时开放。

需求方需要把 dsh 部署为团队服务：
- 多人各自拥有**独立空间**（settings、profile、会话、工作区全部隔离）
- 公共空间可共享已编排好的任务流
- 每个用户的配置存在于**服务器端自己的目录**，客户端浏览器不持有
- 用户的**代码在各人自己的 Linux 主机**上，dsh 需能操作那些远程文件
- 未来支持多机横向扩展

结论：dsh 作为**引擎**，由本 shell 作为**控制面/壳**，负责账号、实例孵化、
生命周期与入口聚合。dsh 自身不改造为多租户（上游也不会合入此类私有改造）；
代码在用户主机这一事实由第 7 章的**远程执行桥**解决。

## 2. 关键决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| 壳是否新开 repo | **同 repo `shell/` 目录** | 用户要求；上游 master 永不创建此目录，merge/rebase 零冲突 |
| 壳语言 | Node/TypeScript | 与 dsh 生态一致，可类型引用 dsh-sdk |
| 每用户实例形态 | dsh web profile（内部 HTTP 端口） | 用户界面复用 dsh web；浏览器只能走 HTTP/SSE，无法连 sdk 的 stdio |
| 端口策略 | 服务器内部端口 + 壳反代聚合 | 用户只访问壳的一个入口；不对内网暴露一堆端口 |
| 账号 vs 端口 | 账号登录后映射到用户实例 | 不需要对每个用户开放独立对外端口 |
| 会话隔离 | 每用户独立 DSH_HOME | dsh 原生支持 `$DSH_HOME`，settings/credentials/sessions 全在用户目录 |
| 实例生命周期 | 混合：对话式长驻+空闲回收；任务式按需 spawn | 200 注册用户按活跃使用方式分流，单机可行、多机可扩展 |
| 上游同步 | shell/ 不注册进 pnpm-workspace，不进 tsconfig/根 package.json | 保证 rebase origin/master 时 shell/ 文件永不冲突 |

## 3. 总体架构

```
┌──────────────────────── 用户浏览器 ────────────────────────┐
│  只访问一个入口: https://dsh.team (或 http://server:3080)  │
└────────────────────────────┬───────────────────────────────┘
                             │ HTTPS/HTTP
┌────────────────────────────▼───────────────────────────────┐
│                   Team Shell (本目录)                       │
│                                                            │
│  ┌──────────┐  ┌──────────┐  ┌─────────────────────────┐  │
│  │ 账号/登录 │  │ 用户目录 │  │ 实例调度/反代聚合        │  │
│  │ (账号密码/│  │ 注册/分配│  │ - spawn 每用户 dsh 实例 │  │
│  │  邀请码)  │  │ DSH_HOME │  │ - 健康检查/崩溃重启      │  │
│  └────┬─────┘  └────┬─────┘  │ - 空闲回收(对话式)       │  │
│       │             │        │ - 按需 spawn(任务式)     │  │
│       └─────────────┼────────┼──────────────────────────┘  │
│                     │        │                             │
│        ┌────────────▼────────▼────────────┐                │
│        │  每用户独立 dsh web 实例          │                │
│        │  (loopback: 内部端口 3xxxx)       │                │
│        │  DSH_HOME=/srv/dsh-users/<uid>    │                │
│        └───────────────────────────────────┘                │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 实例隔离

每个用户 = 一个独立 `DSH_HOME` 目录。dsh 在该 home 下持久化：
- `.credentials.yaml` — 凭据（模型 API key 等）
- `profiles/web/` — web profile 组成（bundles/patch）
- `storages/workspace.json` + 会话 JSONL — 会话历史/工作区
- `.anonymous-user-id` — 匿名身份

隔离是**文件系统级**的：一个用户无法读到另一个用户的凭据/会话/settings。

### 3.2 端口与反代

- 每个实例绑定 `127.0.0.1:<内部端口>`（3xxxx 段由壳分配）
- 壳按登录会话把 `/{user}` 路径反代到对应用户实例
- 用户浏览器只见壳的单一源，token 在壳与实例间流转
- 内部端口段 32768-60999 有 2.8 万个，200 用户绰绰有余（瓶颈是内存非端口）

### 3.3 资源容量（实测基线）

- 当前服务器：64GB 内存 / 32 核
- 单 dsh web 实例空闲 RSS：约 270MB
- 对话式长驻：30-50 槽位（每个活跃 ~1GB，空闲回收）
- 任务式：按并发 spawn，跑完销毁
- 单机混合承载 200 注册用户；多机由壳调度层路由（未来）

## 4. 实例生命周期（两种策略）

### 4.1 对话式长驻（persistent-recycle）

用户登录 → spawn 实例（约 2-5s 冷启动）→ 实例驻留；
空闲 N 分钟 → 壳回收（释放 270MB）；再次访问 → 重新 spawn，
DSH_HOME 在磁盘，历史会话/工作区恢复。

适合：长时间对话式交互（类 IDE/聊天）。活跃用户才有内存成本。

### 4.2 任务式（per-task）

壳中无长驻实例；发起任务 → spawn 实例跑完 → 销毁。
适合：批处理、CI、一次编排。内存只在任务执行期占用。

### 4.3 混合

按用户/请求类型分流。对话式用户进入长驻池；任务提交走 per-task。
这使 200 注册用户无需 200 常驻实例。

## 5. 与 dsh 的集成边界

dsh 侧**零改造需求**（除已在 feature-dynamicui 分支上完成的 A2UI/workflow
功能）。壳通过：
1. `child_process.spawn` 拉起 `dsh --profile web`（源码模式或已装 bin）
2. 每用户注入 `DSH_HOME` 环境变量实现隔离
3. 解析启动 stdout 的 `dsh web: <url>` 行捕获 per-process token
4. 预写 profile manifest（`patchReload: startup`）避免 watcher 依赖
   （当前 sandbox 禁止 inotify；真实服务器无此限制但仍推荐 startup 以免除 watch）

### 5.1 每用户 DSH_HOME 的 provisioning

首次为用户 spawn 前，壳预建该用户的 DSH_HOME 结构与 web profile
manifest（bundles + patchReload: startup + host 配置）。避免 dsh 首次
自动初始化使用默认 `live` reload。

## 6. 目录结构

```
shell/
  package.json     # 独立包, 不进 pnpm workspace
  tsconfig.json    # 自包含 TS 配置
  README.md        # 使用说明
  design.md        # 本文档
  src/
    bin.ts         # CLI 入口 (dsh-shell: spawn-user / proxy)
    spawn-user.ts  # 单用户实例 spawn (最小原型, 已验证)
    reverse-proxy.ts  # 反代入口聚合 (HTTP + WebSocket upgrade)
    remote/        # 远程执行桥 (路径 3)
      executor.ts  # 远程 ShellExecutor (实现 dsh ShellExecutor seam)
      protocol.ts  # 中心 ↔ remote-agent wire 协议
      policy.ts    # 黑白名单策略模型
    agent/         # remote-agent (部署到每台用户 Linux)
      agent.ts     # daemon 入口
      bash-runner.ts  # 本机 bash 执行 + 黑白名单强制
      fs-runner.ts    # 文件读/写/搜索 + 路径白名单
    ...            # 账号/调度 (后续)
  tests/
```

## 7. 远程执行架构（路径 3：用户代码在各自 Linux 上）

### 7.1 真实拓扑

用户的代码不在 dsh 服务器上，而在**每台用户自己的 Linux** 上。dsh 的
shell/fs 工具默认只能操作本机文件系统，因此需要一层**远程执行桥**：

```
用户浏览器 (Windows)
    │  web UI（经壳反代）
    ▼
dsh 服务器（中心）                         用户各自的 Linux 主机
┌──────────────────────────────┐         ┌──────────────────────────┐
│  Team Shell                  │         │  remote-agent (daemon)   │
│  ├─ 账号/调度                 │         │  ├─ 执行 bash（黑白名单） │
│  ├─ 每用户 dsh 实例           │  wire   │  ├─ 文件读/写/搜索        │
│  │   └─ 远程 shell executor ─┼────────►│  └─ 上报进程/文件事件     │
│  └─ 远程 fs provider          │         │  每用户各一台             │
└──────────────────────────────┘         └──────────────────────────┘
```

### 7.2 为什么需要远程执行层

dsh 的能力 seam（shell / fs）是**本机进程语义**：
- `ShellExecutor`（`packages/shell/shell/src/index.ts`）抽象 `resolve/run/start`，
  本地实现经 `ctx.subprocess` 跑 `bash -c`；进程组、信号、kill、输出绑定、
  超时全部是本机语义
- fs 工具（tool-fs 等）直接读写本机路径

要让 dsh 实例（中心服务器）操作**用户 Linux 上的代码**，必须为这两类能力
各提供一个"远程提供方"，把本机语义映射到远程代理上。

### 7.3 remote-agent（部署在每台用户 Linux）

`remote-agent` 是每台用户 Linux 上安装的轻量 daemon。职责：

1. **命令执行**：接收中心 shell 请求 → 本机 `bash -c`（或显式 argv）→
   流式回传 stdout/stderr/exit code
2. **进程生命周期**：后台进程句柄（对应 `ShellProcess`：reads/kill/quiescence）
3. **文件操作**：读/写/搜索用户授权目录
4. **权限管控（黑/白名单）**：中心策略下发，代理本地强制

部署形态：installed-daemon（systemd 服务或用户级守护进程）。通信通道可选
TLS 长连接（中心主动连代理）或代理主动上报（代理在 NAT 后时）。

### 7.4 黑/白名单权限管控

用户指定"通过远程 shell 控制 + 黑白名单权限管控"。设计分层：

| 层 | 职责 | 位置 |
|---|---|---|
| 命令白名单 | 允许执行的命令集（如 `git`、`ls`、`cat`、`grep`、`node` 构建脚本） | 中心策略 + 代理强制 |
| 命令黑名单 | 禁用的危险命令（如 `rm -rf /`、`shutdown`、写系统目录） | 代理强制 |
| 路径白名单 | 代理可读/写的目录根（用户代码目录） | 中心策略下发 |
| 工具级管控 | dsh 工具（fs/tool-fs 等）只能触碰白名单路径 | 中心 dsh 侧 |

关键设计：**代理是最后防线**。即使中心 dsh 被攻破/误配，代理仍拒绝名单外的
命令与路径。中心策略可被用户/管理员按需调整，但代理侧强制执行不可绕过。

### 7.5 与 dsh 能力 seam 的对接（不改 dsh core）

- **远程 ShellExecutor**：实现 `packages/shell/shell` 的 `ShellExecutor`
  抽象（resolve/run/start），`run` 把 spec 编码为远程请求发给代理，
  `start` 返回一个 `ShellProcess` 的远程实现（通过代理维持生命周期）。
  通过 cordis 插件注入覆盖默认本地 executor —— 这是 dsh 允许的扩展点
  （executor 是命名能力，注释明示 "not an implementation"）。
- **远程 fs provider**：dsh 的 fs 能力 seam 同样有 provider 注册点，
  远程 provider 把文件操作转发给代理。文件事件（fs-observation）经代理
  上报回中心。

需要校验点：远程 executor 的 sandbox/session 语义与本地不同。远程侧
"沙箱"就是黑白名单本身（代理无权也无必要再套一层本机 sandbox）。

### 7.6 A/B 路线回顾（settings loopback）

远程执行不改变"settings 在 LAN 不可用"的问题 —— 那是**浏览器→dsh 服务器**
的信任问题，与 **dsh→用户 Linux** 的文件问题是正交的两层。两条路：
- 路线 A：改 dsh 代码，让受信 host（trustedHosts）也能读写 settings
- 路线 B：壳做伪 localhost 映射，让浏览器 hostname 落在 loopback

远程执行落地后，每用户实例的配置（settings）仍然建议走路线 A 放开，
因为实例只服务单一用户，受信列表放开风险可控。

### 7.7 当前实现（`shell/src/remote/`）

方向 B 已按原型落地，组件与分工：

| 文件 | 角色 |
|---|---|
| `protocol.ts` | 中心 ↔ 代理 wire：持久 TCP + 每行一个 JSON 帧（hello/ack、ping/pong、exec、fs:read、stream、exit） |
| `hub.ts` | 代理拨号接入（`net` 监听 + token 鉴权 + 心跳 + 重复连接驱逐）+ loopback HTTP 控制 API（`/api/agents`、`/api/exec`、`/api/fs-read`，NDJSON 流式回传） |
| `agent.ts` | 部署在用户 Linux 的 daemon：出站拨号 + 指数退避重连；`--root` 目录白名单、`--allow-command` 命令白名单、exec 路径参数越界拒绝、`fs:read` realpath 越界拒绝 |
| `client.ts` | 控制端：CLI 与未来 dsh executor 共用 |

验证通过：cat/exec 探针、命令白名单拒绝、绝对路径与 `..` 逃逸拒绝、
`fs:read` 越界拒绝、错误 token 拒绝、hub 重启后代理自动拨回重连。

未做：TLS（当前明文 TCP，仅限内网/可信网络）、`exec` 的会话式
`ShellProcess`（start/reads/kill）、代理侧命令黑名单（现用白名单）、
dsh 实例内 executor/fs provider 注入（§7.5 的下一步）。

## 8. 验证状态

- [x] 最小 spawn 原型：给定用户名 spawn 隔离 dsh web 实例 + 捕获 token URL
- [x] 独立 DSH_HOME 自动初始化完整（credentials/profiles/storages）
- [x] 无 watcher 崩溃（patchReload: startup）
- [x] 反代整链路（HTTP 页面/assets/plugins/鉴权，WebSocket 待真机验证）
- [x] 路线 A：受信 host 放开 settings（trustedHosts 注入浏览器特权面）
- [x] remote 桥：hub + 代理拨号 + exec/fs:read 流式回传 + 白名单/越界拒绝 + 断线重连
- [ ] dsh executor 注入：per-user 实例的 shell/fs 能力替换为经 hub 的远程提供方
- [ ] 账号层
- [ ] 空闲回收/健康检查
- [ ] 多机路由

## 9. 后续里程碑

1. **路线 A settings 放开**：受信 host 也允许 settings 读写（跨包改造）
2. **dsh executor 注入**：把 per-user 实例的 shell executor / fs provider 换成
   经 hub 控制 API 的远程实现（hub/agent 侧已验证，见 §7.7）
3. **远程 fs**：文件读/写/搜索经代理
4. **黑白名单**：命令/路径策略中心下发 + 代理强制
5. **账号层**：用户注册/登录、DSH_HOME 分配、token 管理
6. **生命周期**：健康检查、崩溃重启、空闲回收、任务式 spawn
7. **多机路由**：调度层抽象，单机验证后加 worker 注册
