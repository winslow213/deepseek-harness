# Agent Note: 挂载工作区提示词声明

Status: implemented

[English](2026-09-10-mounted-workspace-prompt-declaration.md) | 中文

## 问题

在团队 shell 中，用户的工作目录是一个**挂载的影子目录**，它镜像了远程主机上的根目录。区域路由器（`region-fs`、`region-shell`）会把影子树下的访问改写回拥有该挂载的 agent，`mount-sync` 则把每个影子目录注册为一个工作区。但系统提示词里没有任何内容告诉模型这一点。模型看到的唯一工作目录信息是 `personaSuffix: Your working directory is {{cwd}}`，而 `{{cwd}}` 解析为 `session.header.cwd`——形如 `/tmp/dsh-shadow/winslow/pairing@WH-D-010484A` 的影子路径，看起来就像一个普通的服务器路径。于是模型会去搜索服务器自己的 home 和工作区目录来找用户的代码，而不是挂载的主机，也不知道该针对哪台主机执行命令。

这个声明不能是一句静态文本，因为挂载路径从来不是固定的：用户可能配对了零个、一个或多个 agent，每个都有自己的影子目录和远程根目录。

## 决策

新增一个注入式插件 `shell/src/remote/mount-declare.ts`，注册一个在组装时动态生成的系统提示词段落。它轮询 hub 挂载表（`/api/mounts`，与路由器读取的同一数据源）并缓存到内存中；该段落的文本函数用现有的 `isShadowPath` / `translateShadowPath` 助手，把当前的 `context.agent.session.header.cwd` 与该缓存进行匹配。生成的文本：

- 当 cwd 缺失、位于影子树之外、或命中的挂载不属于本实例的用户时为空——因此本地会话不会得到多余的文字；
- 指出 cwd 命中的那一个挂载（影子路径 → 远程根目录 → agent id）；
- 列出该用户拥有的每一个挂载，因此无论挂载数量多少，声明都保持正确，且不硬编码任何路径、agent 或数量。

纯渲染逻辑放在 `shell/src/remote/mount-declare-render.ts`，以便独立的 `node:test` 运行器（无法解析 `@deepseek-ai/*`）可以测试它；插件文件只负责缓存、轮询和 `ctx.systemPrompt.section` 注册。该段落位于新增的中央顺序槽 `MOUNTED_WORKSPACE: 10150`（位于 `WEB_SURFACE` 与 `DEPLOYMENT_PERSONA_SUFFIX` 之间）。`injectRegionRouter` 生成的 profile patch 在 `declareMounts` 为真时插入一行 `region-mount-declare`，而 `spawn-user` 在已有的 `syncMounts`/`includeShell` 旁设置 `declareMounts: true`。

## 备选方案

### 为什么不覆盖一个静态的 `personaSuffix`？

一句固定的"你的工作目录是挂载目录"对本地会话（它们也走同一个 profile）是错误的，而且无法指出 cwd 对应哪个挂载、哪台主机、哪个 agent。当用户添加或移除挂载时它也无法自适应。

### 为什么不把声明作为 agent-instructions 文件写进影子目录？

影子目录是按需创建、卸载时删除的，所以那里的文件无法在挂载变更中存活，还需要自己的一套生命周期管理。它也无法得知用户拥有的*其他*挂载。

### 为什么不为每个挂载分配一个新的段落顺序？

段落位置是一个固定、集中分配的列表，而非按数据分配。所有挂载会话共用一个顺序槽，既保持组装稳定，内容又保持动态。

## 后果

- 挂载会话现在会收到一条显式且始终准确的 cwd→主机映射声明以及完整挂载列表；本地会话不变。
- 该声明依赖一次 hub 轮询（默认 30 秒，与 `mount-sync` 相同节奏）。一次短暂的 hub 故障会保留上一次已知的挂载，而不是把模型即将读到的文字清空。
- 新增的 `MOUNTED_WORKSPACE` 顺序是已发布包的一个表面变更；cordis 目录已从 `SECTION_ORDERS` 派生 `PromptSectionOrderName`，因此无需重新生成目录。
