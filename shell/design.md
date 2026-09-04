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
| `protocol.ts` | 中心 ↔ 代理 wire：持久 TCP + 每行一个 JSON 帧（hello/ack、ping/pong、exec/kill、fs:read、fs:op/fs:result、stream、exit） |
| `hub.ts` | 代理拨号接入（`net` 监听 + token/pairing 鉴权 + 心跳 + 重复连接驱逐 + 配对码一次性消费）+ loopback HTTP 控制 API（`/api/agents`、`/api/pairings`、`/api/exec`、`/api/kill`、`/api/fs-read`、`/api/fs`，NDJSON 流式回传；exec 接受客户端自带 id 以便静默命令仍可 kill） |
| `agent.ts` | 部署在用户主机（Linux 或 Windows）的 daemon：出站拨号 + 指数退避重连；`--root` 目录白名单、`--allow-command` 命令白名单、exec 路径参数越界拒绝（shell `bash -c` / Windows `cmd /c` 脚本体豁免）、进程组 kill、fs 原语分发 |
| `agent-fs.ts` | **零依赖 fs 语义移植**（fsio 核心）：probe/versionOf、regular/binary/UTF-8 拒绝、LF 归一化/恢复、字面编辑匹配、原子写发布、带版本守卫的 write/edit |
| `executor.ts` | **远程 ShellExecutor**（实现 `ctx.shell` seam）：resolve 默认/封顶，run 按工作目录平台选 shell —— Windows 目录（盘符/反斜杠，如 `D:\work`）走 `cmd /c`、其余 `bash -c` —— 发到 hub 并流式回填 `CollectedOutput`，超时/abort 经 `/api/kill` SIGKILL 进程组并分类 `timedOut/aborted`，start 维持后台进程的增量读/kill/done |
| `fs-provider.ts` | **远程 FileSystem**（实现 `ctx.fs` seam）：resolve/processPath/fileUrl/contains/stat/lstat/readText/streamText/readBytes/listDir/writeText/editText 全经 `/api/fs` 落到 agent；`sandboxMode` 报 undefined（tool 层按非 confine 处理） |
| `client.ts` | 控制端：CLI、executor、fs-provider 共用 |
| `inject.ts` | 把 executor+fs-provider 源码副本拷进用户 profile 的 `plugins/remote`，写 `cordis.patch.yml`：disable 本地 bash/pwsh/fs-sandbox、插入远程行（`sandboxMode` 声明 agent root 的权限意图） |

执行模型：executor 以 `bash -c <command>`（POSIX 目录）或 `cmd /c <command>`
（Windows 目录）作为 exec 原语 —— 平台由工作目录承载：影子翻译保真了
agent root 的路径风格（`D:\...` 盘符/反斜杠 = Windows），executor 据此选
shell。故 POSIX agent 必须 `--allow-command bash`、Windows agent 必须
`--allow-command cmd` 才能执行任意 shell 命令 —— 白名单 shell 即授权任意
命令，与"bash 工具 = 本机全权"的语义一致；如需收紧用路径/命令细分白名单。
fs 原语全部在 agent 内做白名单 realpath 校验后执行，中心侧无从越界。

配对流程（网页/CLI 生成一次性码 → 用户在目标主机 CLI 认领）：`remote pair`
mint 码 → `remote agent --pair <uuid>` 拨号 → hub 校验、绑定该码的用户、
触发 `onPaired` 自动注入远程 provider（可 `--no-auto-inject` 关闭）。

验证通过：cat/exec 探针、命令白名单拒绝、绝对路径与 `..` 逃逸拒绝、
`fs:read` 越界拒绝、错误 token 拒绝、hub 重启后代理自动拨回重连、exec
静默命令经客户端自带 id kill、真实 dsh web 实例装配远程 executor+fs
启动、executor run 超时（SIGKILL/timedOut 分类）与后台 start、fs 原语
stat/readText/listDir/write(带 before/版本守卫)/edit(字面匹配)/stale
拒绝/二进制拒绝、ctx.fs 经 RemoteFileSystem 全语义 harness、配对码
一次性消费与自动注入。

未做：TLS（当前明文 TCP，仅限内网/可信网络）、代理侧命令黑名单（现用
白名单）、搜索工具（tool-fs-search 独立 spawn 化，未桥接）、配对网页页。

## 8. 验证状态

- [x] 最小 spawn 原型：给定用户名 spawn 隔离 dsh web 实例 + 捕获 token URL
- [x] 独立 DSH_HOME 自动初始化完整（credentials/profiles/storages）
- [x] 无 watcher 崩溃（patchReload: startup）
- [x] 反代整链路（HTTP 页面/assets/plugins/鉴权，WebSocket 待真机验证）
- [x] 路线 A：受信 host 放开 settings（trustedHosts 注入浏览器特权面）
- [x] remote 桥：hub + 代理拨号 + exec/fs:read 流式回传 + 白名单/越界拒绝 + 断线重连
- [x] dsh executor + fs 注入：远程 ShellExecutor + RemoteFileSystem 装配进
  per-user dsh web 实例（run/超时/后台 start + ctx.fs 全语义验证）
- [x] 配对：一次性码 mint/认领/消费 + 自动注入远程 provider
- [ ] 配对网页页（浏览器内 mint 码并展示认领指令）
- [ ] 账号层
- [ ] 空闲回收/健康检查
- [ ] 多机路由

## 9. 后续里程碑

1. **路线 A settings 放开**：受信 host 也允许 settings 读写（跨包改造）
2. **dsh executor + fs 注入**：远程 ShellExecutor + RemoteFileSystem 已装配
   （§7.7）；剩余搜索工具桥接（tool-fs-search 独立 spawn 化）
3. **配对网页页**：浏览器端生成配对码 + 展示认领指令，供跨设备挂载
4. **黑白名单**：命令/路径策略中心下发 + 代理强制
5. **账号层**：用户注册/登录、DSH_HOME 分配、token 管理
6. **生命周期**：健康检查、崩溃重启、空闲回收、任务式 spawn
7. **多机路由**：调度层抽象，单机验证后加 worker 注册

### 7.8 形态 A：单实例双后端（workspace 分本地/挂载区）

需求：**同一个**用户 dsh web 实例里，"工作区"分两类可自由选择——本地区
（本机授权目录）与挂载区（配对 agent 提供的根）。探索确认 upstream 无法在
同一 realm 注册两个 `ctx.fs`/`ctx.shell`，dsh 的既有模式是
`sandboxPolicy.resolve({ session })`（单一服务按会话参数路由）。据此定案：

**架构：单一 RegionRouter provider + 虚拟挂载前缀**

```
用户 dsh 实例（一个进程、一份 profile）
  ctx.fs  = RegionRouterFileSystem（单一 provider）
    ├─ ctx.isolate('fs', local)   → 本地 delegate（原 fs-sandbox）
    ├─ ctx.isolate('fs', remote)  → RemoteFileSystem（经 hub 到配对机）
    └─ resolve(path,{cwd}) 见 cwd 前缀分派：
         /dsh-mount/<user>/<agent>/…  → 剥离前缀 → 远端 agent root
         其余绝对路径                   → 本地 delegate
  ctx.shell = RegionRouterShellExecutor（同构；虚拟前缀 → 远端 bash，
              本地路径 → 本地 bash-sandbox）
```

- **工作区 = 一个路径根**（不变 upstream 模型）：本地区 workspace 路径是真实
  服务器目录；挂载区 workspace 路径是 `/dsh-mount/<user>/<agent>/` 虚拟前缀
  下的一个目录（内容由远端 agent 提供）。`session.header.cwd` 仍是绝对路径，
  校验与工具层解析全部照旧。
- **工具层零改动**：read/write/edit/bash 解析相对路径的基准仍是
  `session.header.cwd`，经 `ctx.fs`/`ctx.shell` 单点进入 router。
- **本地只授权目录**：本地区目录仍由既有 `directory-picker` 原生/浏览门禁
  限定；router 不新增本地放行。
- **挂载区 = 配对即现**：配对 agent 的 `roots` 以虚拟前缀注册进 router
  （user→agent→roots→hub 路由表），UI 挂载区即可刷出选中。
- **路由表来源**：hub 的 agent 在线表 + 每 agent 的虚拟前缀映射，经一个
  loopback host 插件暴露给实例。

关键决策：virtual 前缀而非 session 存"远端 id"，使 session header cwd 仍是
纯字符串绝对路径，`workspace.json`、session-log、快照等不下游改动；远端身份
经前缀推导。风险与校验点：目录观察（fs-observation）、session 标题/快照把
虚拟路径当真实路径处理——行为与本地一致因为它们只操作字符串。

落地分层（每层独立可验证）：
1. RegionRouterFileSystem/Shell：isolate 双 delegate + 前缀分派（host 侧单测）
2. 挂载前缀路由表：hub agents → /dsh-mount/<user>/<agent> 映射（shell 侧）
3. profile 装配：注入 patch 用 RegionRouter 替换 fs-sandbox/remote-fs 两行
4. UI：WorkspacePicker/Browser 加挂载区列表（client 侧，slots 组合）
5. 配对完成后 UI 自动出现该 agent 挂载区

## 8. 验证状态

### 7.9 形态 A 落定：影子目录桥（方向 2）

探索证实 dsh 的 workspace/session 深度绑定真实文件系统：`workspaceRegistry.create`
realpath+stat 目录、session 挂载与启动索引同样校验，虚拟前缀 `/dsh-mount/...`
无法注册成 workspace（ENOENT 拒绝）。定案改走**影子目录桥**：

```
配对 agent 上线 → hub 建真实影子目录 /srv/dsh-mounts/<user>/<agent>/<ordinal>/
                     （每个 agent root 一个空目录；workspace 可 realpath/stat）
UI 工作区 = 影子路径（dsh 无感知：存在、可 stat、可绑定 session）
工具调用 (fs/bash) → RegionRouter
  ├─ cwd 命中 /srv/dsh-mounts/<user>/<agent>/<ordinal>/ 前缀
  │     → 翻译：影子相对路径 + 映射的 agent root → hub fs:op / exec
  └─ 其它 → 本地 delegate（原 fs-sandbox / bash-sandbox）
```

- 影子目录本身内容为空壳；RegionRouter 拦截所有对它的访问并转发远端，
  因此 UI 目录浏览/搜索看到的是远端真实内容（经 router 翻译）。
- 路由表 = hub 的 mounts（user→agent→roots→影子路径），agent 离线则该
  影子目录对 router 返回"agent 离线"错误。
- workspace/session/快照零改动；新增 shell/ 层 RegionRouter + 影子目录
  provision，装配仍走 profile inject。

落地：
1. shadow 目录 provision + hub mounts 端点（已加 /api/mounts）
2. RegionRouterFileSystem（影子前缀→hub fs:op）
3. RegionRouterShellExecutor（影子 cwd→hub exec）
4. profile 装配 + 双 delegate
5. UI 挂载分区（picker/browser 第二来源）

## 10. 上游 master 同步对照（2026-09-04 合并 #3427→#3481）

本节记录把上游 master 前移 107 commits 后对壳子设计的影响审计结果：
**无功能重复**、三项可借鉴、一项需警惕。合并本身（类型适配与
catalog 重生成）不改变本节结论。

### 10.1 无功能重复

| 上游功能 | 与壳子的关系 |
|---|---|
| `packages/util/http-proxy`（出站代理策略） | 方向相反：上游管 harness **出站**按 `HTTP(S)_PROXY` 路由；本壳 `reverse-proxy.ts` 管**入站** LAN→loopback 转发。互补，不重叠 |
| `web-app` startup 阻止 `--host 0.0.0.0` | 未变——reverse-proxy 仍是 LAN 暴露的唯一途径 |
| agent-team steer / mailbox | 上游是单实例内的会话消息改造；本壳的多用户实例层在其上层，不重复 |
| 账号 / 多租户 / 实例孵化 | 上游无此方向——本壳仍是唯一实现 |
| `workflow-worker-thread/src/host.ts` | 上游只加了 proxy 依赖注入；node-profile / `agent({ profile })` 扩展保留完好 |

### 10.2 上游可借鉴的实现

1. **`util/http-proxy` 的 `egress.spec.ts` 验证法**：用 fake proxy 驱动真实
   代码路径并断言请求真经代理——壳子的 hub/agent 若加"企业代理出站"
   支持，照此方法写验证。shell/ 不在 pnpm workspace，无法 import 该库，
   但可移植其验证模式。
2. **session-persistence handle seam + storage 跨版本读兼容**：上游把持久化
   收敛到 handle seam 并支持升级后仍可读 + 损坏时备份-跳过。壳子的挂载
    workspace 记录在 `workspace.json`，若演进需版本化，套用这套范式。
3. **`util/http-proxy` 的 dispatcher 语义**：进程级 transport 策略一进程
   一个答案——壳子若做类似进程级策略，先想清"是否每个进程唯一"。

### 10.3 需警惕

上游 proxy 策略门 `verify-no-bare-dispatcher` 拒绝绕过代理的自建
`new Agent()` dispatcher。壳子 hub/agent 的出站 fetch 若自建 dispatcher
需防此门（shell/ 当前不在该门扫描范围；agent 的 agent↔hub 通道是纯
`net` TCP socket，不受影响）。

### 10.4 维护含义

- 上游每次前移都用 `git merge`（shell/ 不进 workspace，理论上零冲突，
  实际仅 `pnpm-lock.yaml` 与跨两边的自研改动需要人工）。
- 上游若新增账号/远程方向，优先看它是否替代壳子的 region/影子桥，再
  决定 shell 层去留。

## 8. 验证状态
