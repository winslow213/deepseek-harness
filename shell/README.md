# dsh Team Shell

团队公用型 DeepSeek Harness 服务的壳层：账号、每用户实例孵化、生命周期管理。

> **设计**：[design.md](design.md)
>
> **独立定位**：本目录刻意**不进 pnpm workspace**、不注册进根 tsconfig /
> package.json。上游 master 永不创建此目录，因此 `git rebase origin/master`
> 时本目录零冲突。

## 快速开始

```sh
# spawn 一个用户的独立 dsh web 实例（loopback 内部端口）
node --import tsx/esm shell/src/bin.ts spawn-user alice 32001
```

输出会打印带 token 的 URL（如 `http://127.0.0.1:32001/?token=...`）。

## 远程执行桥（remote）

把每个用户**各自 Linux 主机上的代码**接进中心 dsh。方向 B：用户主机上的
`remote-agent` 主动出站拨号 hub（NAT 后无需入站端口），hub 在 loopback 暴露
HTTP 控制 API，未来 per-user dsh 实例的 shell/fs 能力经由它落到用户主机
（见 [design.md](design.md) §7）。

```sh
# 1) hub：监听 agent 拨号 + loopback 控制 API
node --import tsx/esm shell/src/bin.ts remote hub \
  --agent-port 7101 --control-port 7100 \
  --user-token alice=SECRET_A --user-token bob=SECRET_B

# 2) 用户 Linux 上跑 agent（可 systemd 常驻）
node --import tsx/esm shell/src/bin.ts remote agent \
  --user alice --token SECRET_A --hub 10.33.2.56:7101 \
  --root /home/alice/code \
  --allow-command cat --allow-command git --allow-command ls

# 3) 中心侧验证
node --import tsx/esm shell/src/bin.ts remote agents --control-port 7100
node --import tsx/esm shell/src/bin.ts remote cat  --control-port 7100 alice /home/alice/code/README.md
node --import tsx/esm shell/src/bin.ts remote exec --control-port 7100 alice git -C /home/alice/code status
```

agent 是本桥的**最后防线**：只执行白名单命令、只读/写 `--root` 内的目录
（绝对路径与 `..` 逃逸都拒绝），即使中心被攻破也无法越界。

### 让用户的 dsh 实例用远程执行（inject）

把 per-user 实例的 bash 能力指向其主机上的 agent：

```sh
# 把远程 executor 拷进 <DSH_HOME>/profiles/web/plugins/remote 并写 patch
# （disable 本地 sandbox executor、插入 remote-shell 行）
node --import tsx/esm shell/src/bin.ts remote inject \
  --home /srv/dsh-users/alice --hub http://127.0.0.1:7100 \
  --user alice --cwd /home/alice/code \
  --sandbox-mode workspace-write   # 声明 agent root 的权限意图（默认 workspace-write）

# agent 侧必须允许 bash 才能执行任意 shell 命令
node --import tsx/esm shell/src/bin.ts remote agent \
  --user alice --token SECRET_A --hub 10.33.2.56:7101 \
  --root /home/alice/code --allow-command bash --allow-command cat
```

之后该用户实例的模型 `bash` 工具调用会经 hub 落到其主机上执行
（`resolve`/`run`/后台 `start`、超时与 kill 语义等同本地）。
删除 `cordis.patch.yml` 即回退本地 executor。

## 开发

```sh
# 独立 shell 编译/类型检查（不含 executor.ts，它在 dsh 运行时内解析依赖）
npx tsc -p shell/tsconfig.json --noEmit
# executor.ts 在仓库源图下检查（引 @deepseek-ai/dsh-shell）
npx tsc -p shell/tsconfig.executor.json --noEmit
```

## 状态

最小 spawn 原型、反代聚合、路线 A settings 放开、remote 桥原型与
**dsh executor 注入**（远程 ShellExecutor 装配进 per-user dsh 实例，
前台/超时/后台全语义验证）已完成；远程 fs provider、账号层、生命周期
管理见 [design.md](design.md) 里程碑。
