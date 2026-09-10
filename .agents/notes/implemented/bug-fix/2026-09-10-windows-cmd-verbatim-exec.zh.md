# Agent Note: 在远程 agent 中将 Windows 命令原样传给 cmd.exe

Status: implemented

[English](2026-09-10-windows-cmd-verbatim-exec.md) | 中文

## 问题

远程 agent 用 `spawn(argv[0], argv.slice(1))` 执行转发的命令。在 Windows 上，团队 shell 会把每条命令都路由为 `cmd /c <command>`（见 `executor.ts` 中的 `shellArgvFor`），于是模型探测某个工具时常常会发送类似这样的命令：

```
dir /b "D:\ohos\ohos_sdk\13\toolchains\bin" 2>&1 | findstr /i "hdc"
```

Node 默认的 argv→命令行引号处理（在缺少 `windowsVerbatimArguments` 时启用）会用引号包裹含空格的参数，并用反斜杠转义其内部的双引号。而 `cmd.exe` **不**把 `\` 当作转义字符，于是 `/c` 后的命令行到达 cmd 时引号已经被破坏。管道和嵌套引号因此无法按调用者的意图解析，`findstr`——在没有文件参数时会读 stdin——就一直等待永远不会到来的输入，导致命令挂起而不是返回。

之前报告的裸 `findstr /i dsh` 挂起属于同一类故障：`findstr` 没有文件参数、也没有可用的管道时会读 stdin。本修复解决的是这一类故障中 argv 引号的那一半。

## 决策

`agent.ts` 中的 `runExec` 在命令二进制为 `cmd` 或 `cmd.exe` 时传入 `windowsVerbatimArguments: true`。这告诉 Node 原样（用空格拼接）把 argv 交给 `CreateProcess`，而不是重新加引号，于是 `cmd /c` 收到的命令行与 executor 构造时完全一致，由 cmd 自己解析管道和嵌套引号。该标志只影响 `win32`，因此 POSIX 的 `bash -c` 路径不变。

## 备选方案

### 为什么不改写命令以避免 `findstr`？

改探测命令（例如 `where hdc`，或 `if exist "...\hdc.exe"`）能避开这一个实例，但避不开整类问题：模型会生成任意的 Windows 命令，任何含管道或嵌套引号的命令都会撞上同样的引号损坏。executor 必须执行被要求执行的内容，因此修复应落在 agent 的 spawn。

### 为什么不改用 `/s` 或加上 `/d`？

`cmd /s /c` 只改变 cmd 如何剥离*首尾*的一对引号，并不能修复 Node 对内部引号的反斜杠转义。`/d`（禁用 AutoRun）是无关的卫生改进，不能修复这个损坏。

### 为什么不全部通过临时 `.cmd` 脚本执行？

把命令写入临时脚本再执行能绕开 `/c` 的引号问题，但每次 exec 都要增加文件生命周期和清理，而且当脚本路径含空格时仍需要正确的引号。原样 argv 是最小、最标准的修复。

## 后果

- 含管道和嵌套引号的 Windows 命令现在按 cmd 的解析方式执行，因此 `dir ... | findstr ...` 不再挂起。
- 该保护只作用于 `cmd`/`cmd.exe`；非 cmd 的二进制保持 Node 默认引号，POSIX 不受影响。
- 引号修复必要但不充分：同一类故障中「脱离控制台」的那一半在 [detached console 笔记](2026-09-10-windows-detached-console-exec.zh.md) 中修复。
- agent 是唯一执行转发命令的位置，因此一处修改覆盖了所有 shell 与 fs 驱动的 exec 路径。
