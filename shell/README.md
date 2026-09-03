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

## 开发

```sh
# 类型检查（复用仓库根已装的 typescript/tsx）
npx tsc -p shell/tsconfig.json --noEmit
```

## 状态

最小 spawn 原型已验证；反代整链路、账号层、生命周期管理见
[design.md](design.md) 里程碑。
