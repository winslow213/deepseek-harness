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
- 未来支持多机横向扩展

结论：dsh 作为**引擎**，由本 shell 作为**控制面/壳**，负责账号、实例孵化、
生命周期与入口聚合。dsh 自身不改造为多租户（上游也不会合入此类私有改造）。

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
    bin.ts         # CLI 入口 (dsh-shell)
    spawn-user.ts  # 单用户实例 spawn (最小原型, 已验证)
    ...            # 账号/调度/反代 (后续)
  tests/
```

## 7. 验证状态

- [x] 最小 spawn 原型：给定用户名 spawn 隔离 dsh web 实例 + 捕获 token URL
- [x] 独立 DSH_HOME 自动初始化完整（credentials/profiles/storages）
- [x] 无 watcher 崩溃（patchReload: startup）
- [ ] 反代整链路（用户浏览器 → 壳 → 用户实例）
- [ ] 账号层
- [ ] 空闲回收/健康检查
- [ ] 多机路由

## 8. 后续里程碑

1. **反代整链路**：壳起一个 HTTP 入口，登录后反代到用户实例（验证 UI 可用）
2. **账号层**：用户注册/登录、DSH_HOME 分配、token 管理
3. **生命周期**：健康检查、崩溃重启、空闲回收、任务式 spawn
4. **多机路由**：调度层抽象，单机验证后加 worker 注册
