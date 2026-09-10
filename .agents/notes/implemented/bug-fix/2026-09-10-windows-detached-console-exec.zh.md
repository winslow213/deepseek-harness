# Agent Note: 在远程 agent 中以正确控制台执行 Windows 命令

Status: implemented

[English](2026-09-10-windows-detached-console-exec.md) | 中文

## 问题

在 argv 引号修复（[verbatim exec 笔记](2026-09-10-windows-cmd-verbatim-exec.zh.md)）之后，Windows 命令依然异常：`findstr` 挂起，外部程序（`hostname`、`where`、`hdc`）的 stdout 变成 `?` 或空，而 cmd 内建命令（`echo`、`ver`、`dir`）输出正常。

区分性的线索是「内建 vs 外部」的分界。cmd 内建命令在 cmd.exe 进程内执行，直接写它自己的 stdout 管道；外部程序由 cmd.exe 作为控制台应用子进程 spawn。这些子进程之所以失败，是因为 agent 用 `detached: true` spawn cmd.exe——在 Windows 上这会赋予 cmd 一个脱离（detached）的控制台。控制台被破坏后，cmd 所 spawn 的控制台应用无法正常运行或写输出——`findstr` 卡在控制台 I/O 上而不返回，其它外部程序则产出 `?`/空 stdout。

## 决策

`agent.ts` 的 `runExec` 在 Windows 上不再 detach：

- `detached: process.platform !== 'win32'` —— 只在 POSIX 上 detach，使子进程成为进程组组长以便 `process.kill(-pid)` 生效。
- `windowsHide: process.platform === 'win32'` —— 隐藏控制台窗口而不是将其 detach。
- `killProcessGroup` 在 Windows 上用 `taskkill /PID <pid> /T /F` 终止进程树（没有 POSIX 风格的组可发信号），POSIX 保持 `process.kill(-pid, 'SIGKILL')` 路径。

这与本地 subprocess provider（`packages/subprocess/subprocess-local/src/spawn.ts`）一致，后者是本仓库权威的 Windows spawn 模式。

## 备选方案

### 为什么保留 `detached: true` 而只修引号？

引号修复（[verbatim exec 笔记](2026-09-10-windows-cmd-verbatim-exec.zh.md)）是必要但不充分的。它修好了 cmd 解析的命令行，但脱离的控制台仍会破坏 cmd 所 spawn 的控制台应用，所以无论引号如何，`findstr` 仍挂起、外部程序仍丢 stdout。

### 为什么不绕过 cmd 直接跑外部程序？

exec 是穿过 agent 白名单的单个 argv；平台 shell（`cmd`/`bash`）是对外提供任意 shell 命令的文档化方式。把每个外部程序绕开 shell 会重新拆解命令行，并重新引入 shell 本已承担的引号问题。

### 为什么不同时用 `windowsHide` 加 `detached: true`？

`detached: true` 本身就是破坏子进程控制台的元凶；`windowsHide` 只隐藏窗口，无法修复一个已脱离的控制台。两者不可互相替代。

## 后果

- `cmd /c` 所 spawn 的外部程序现在能返回真实 stdout，因此 `dir ... | findstr` 返回匹配结果而不再挂起，`hostname`/`where`/`hdc` 的输出也不再是 `?`/空。
- Windows 上的树终止改用 `taskkill /T /F`，能连带终止管道子进程（如 `findstr`）；此前的 `process.kill(-pid, 'SIGKILL')` 在 Windows 上是无效操作。
- POSIX 行为不变：那里仍设置 `detached`，进程组信号路径得以保留。
