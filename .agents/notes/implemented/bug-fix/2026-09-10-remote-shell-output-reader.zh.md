# Agent Note: 远程 shell 进程暴露独立的输出读取器

Status: implemented

[English](2026-09-10-remote-shell-output-reader.md) | 中文

## 问题

A2UI 实时结果面板对后台 shell 进程调用 `proc.createOutputReader()`，命中了 `TypeError: proc.createOutputReader is not a function`。能力接缝的 `ShellProcess` 接口要求 `createOutputReader(): ShellProcessReader`——一个独立的、不消费的游标，让第二个消费者（实时结果流）能够跟随输出而不消费主 `readOutput` 的增量。本地 provider（`bash-local`、`pwsh-local`）已经实现了它，但远程 executor 的 `background()` 返回的 `ShellProcess` 只有 `readOutput`，因此任何针对挂载（远程 agent）命令的实时结果消费者都会崩溃。

## 决策

`shell/src/remote/executor.ts` 的 `RemoteShellCore.background()` 现在通过一个 `makeReader()` 闭包来构建读取器，该闭包在两个有界流上持有自己的 stdout/stderr 偏移，与 `bash-local` 对齐。`readOutput` 是主读取器，`createOutputReader()` 返回一个全新的独立读取器，因此多个消费者互不干扰。一次性 provider 失败提示通过共享的 `consumeSpawnError()` 路由，确保只投递一次——由先轮询到它的任一读取路径投递。

## 备选方案

### 为什么不把实时结果面板路由到 `readOutput`？

面板的读取器不能消费工具自身的 `readOutput` 游标，否则主消费者会漏掉输出。接缝契约正是为此定义了 `createOutputReader`，所以修复应落在 provider 而非消费者。

### 为什么不对挂载命令禁用实时结果面板？

那会静默降低产品可见行为（挂载场景没有实时面板），而不是补上缺失的能力。挂载命令与本地命令应当表现一致。

## 后果

- 实时结果流现在能挂到挂载命令上而不再抛错；面板通过自己的游标接收增量输出。
- 主 `readOutput` 游标对现有消费者保持不变。
- 无需重启 daemon：`executor.ts` 运行在 per-user dsh 实例内（由 `injectRegionRouter` 复制到 profile），刷新后的副本在下一次实例启动时加载。
