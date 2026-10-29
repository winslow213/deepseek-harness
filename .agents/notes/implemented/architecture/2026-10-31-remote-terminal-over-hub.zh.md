# Agent Note: Terminals run on the paired device

Status: implemented

[English](2026-10-31-remote-terminal-over-hub.md) | 中文

## Problem

[挂载会话终端限制](2026-10-28-mount-scoped-terminals.zh.md) 阻止了挂载会话的终端把服务器 shell 冒充成成员的机器，但终端本身仍是服务器 shell：`terminal-controller` 通过 `ctx.subprocess.spawnTerminal` 分配，而团队部署里唯一的 `ctx.subprocess` 是 Host 上的 `subprocess-local`。成员在自己的挂载上打开终端，得到的 shell 里每个可见路径都是影子副本，于是用这个终端改文件，改的是同步副本而不是设备。

线协议也无法表达终端。它只有 `exec`、`kill` 与 `fs:*` 帧，而 `exec` 是一次性的：起一个进程组、流式输出 stdout/stderr、报告退出。终端需要交互式 stdin、窗口尺寸，以及按字节流而非按行输出的结果。

## Decision

协议新增终端帧：hub 发出 `pty:open`、`pty:write`、`pty:resize`，agent 回 `pty:opened`、`pty:data`、`pty:exit`。hub 在 `/api/exec` 旁边提供 `/api/pty`、`/api/pty-write`、`/api/pty-resize`；分配请求像 exec 一样以 NDJSON 流式应答，写入与改变尺寸则立即返回，因为终端的结束由它自己的退出帧表达。输出以 base64 编码在 JSON 行内传输，因此被分片切断的多字节字符能完整往返。

agent 用 `node-pty` 提供终端，首次分配时才加载，因此从不打开终端的部署不会为这个原生模块付出代价。分配受 `exec` 相同的那两份名单约束 —— `argv[0]` 的基名必须被允许，`cwd` 必须落在已服务的根下 —— 因为终端严格强于一次 exec。通道关闭时会杀掉它分配过的每个终端，否则孤儿 shell 会留在成员机器上而无人在握它的句柄。

置备的 profile 里由一个新增的 `region-subprocess` 提供方替代 `subprocess-local`。它继承本地提供方，只覆写 `spawnTerminal`：`cwd` 在影子根或其下的终端分配到配对 agent，其余调用保持本地语义。路由以 `spec.cwd` 为键，因为它是终端 seam 唯一携带的执行世界参数；shell 发现仍留在 Host（`terminalEnvironment()` 与 `resolveExecutable()` 不接受目录参数），所以设备上找不到该确切可执行文件时分配失败，而不是悄悄换一个 shell。

## Alternatives considered

**整体把 `ctx.subprocess` 换成远程提供方。** 不采纳：`exec`、管道式 `spawn`、可执行文件查找与 shell 环境探测在本协议里都没有远程对应物，替换整个服务会让每个会话里的 `tool-fs-search`、`lsp-stdio` 与 subagent 工具失效，而不是只路由一个面。继承本地提供方把改动限制在唯一有设备等价物的方法上。

**在 spawn 规格上加一个显式的执行世界字段来路由终端。** 不采纳：终端 seam 没有该字段，加上它会让线上契约依赖某个 Host 侧插件的路由概念。工作空间路径本身已经标识了世界，而同一个 `shadowRoot` 值同时决定文件系统路由与终端资格。

**按长度前缀的二进制帧传原始 PTY 字节。** 不采纳：hub 的请求通道是 HTTP 上的 NDJSON，在里面再套一层二进制协议在这些数据量下没有收益，却要为两端各添一个解析器。

**让 agent 报告远程终端活动。** 不采纳：agent 的 PTY 不报告 shell 生命周期，因此 `inspectActivity()` 返回 `unknown`、`inspectForeground()` 返回空。自动回收因此永不把远程终端当作空闲；保留一个终端会一直占用终端配额直到用户关闭，对于活的用户 shell 这是保守的方向。

## Consequences

在挂载工作区里打开的终端运行成员自己的 shell、在他们自己的目录里。`ctx.subprocess` 的其余部分保持本地语义，因此在挂载工作区里搜索仍读影子副本 —— [region 设计](../../../../shell/design.md) §13.6 记录了这处剩余缺口以及它需要的标识符改造。

远程 agent 不再零依赖：它需要 `node-pty` 1.2.0-beta.15，其预编译二进制覆盖 macOS、Linux、Windows 的 arm64 与 x64。该提供方按 profile 选择启用，从不启用它的部署仍是一个什么都不用装的 agent。

`createHub` 现在返回实时的 `agentPort`/`controlPort` getter 以及 `ready` promise：`listen` 是异步绑定的，先前请求临时端口（`0`）的调用方无从得知真实端口。

Coverage: `shell/tests/pty-roundtrip.spec.ts` 跑真实 hub、子进程里的真实 agent 与真实 PTY，断言交互输入输出、请求的工作目录、两份名单的两种拒绝，以及终止。
