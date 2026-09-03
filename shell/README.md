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

## 开发

```sh
# 类型检查（复用仓库根已装的 typescript/tsx）
npx tsc -p shell/tsconfig.json --noEmit
```

## 状态

最小 spawn 原型、反代聚合、路线 A settings 放开与 remote 桥原型
（hub + agent 拨号 + exec/fs:read + 白名单/断线重连）已验证；dsh executor
注入、账号层、生命周期管理见 [design.md](design.md) 里程碑。
