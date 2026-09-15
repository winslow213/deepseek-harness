# Agent Note: 项目根目录标记探测在路径被拒绝时容忍处理，而不是让遍历崩溃

Status: implemented

[English](2026-09-16-agent-instructions-marker-probe-tolerates-denial.md) | 中文

## 问题

`findProjectRoot`（`packages/context/agent-instructions/src/files.ts`）从会话 cwd 向上遍历，寻找项目根标记（默认是 `.git`），在第一个包含该标记的目录处停下，或者一直走到文件系统根目录。它调用的逐目录探测函数 `existsAsMarker`，此前只把 `FS_NOT_FOUND`（经由 `ctx.fs` provider）或者 `ENOENT`/`ENOTDIR`（经由宿主 `node:fs/promises`）当作"标记不存在，继续往上走"——其余任何错误，包括权限拒绝，都会被重新抛出，直接中止整个遍历。`findProjectRoot` 几乎在每一轮对话都会运行（它为基线 instruction 发现提供数据），而且按设计它的遍历总会一路走到会话 cwd 之上、直至文件系统根目录，完全不知道某个 `ctx.fs` provider 可能设有怎样的读边界。

团队壳的 region-router（见[工作区隔离笔记](../architecture/2026-09-07-team-shell-per-user-workspace-confinement.zh.md)）把本地读操作限制在账户私有的 `workspaceRoot` 内，越界的 `stat` 会以 `FS_PERMISSION_DENIED` 被拒绝。由于 `findProjectRoot` 的遍历总会往上跨出会话 cwd 一级——而在团队壳会话中，这一级正是账户的工作区根目录——第一次越过这道边界的标记探测就会撞上这道拒绝，导致整轮对话崩溃。同样形状的失败在普通宿主文件系统上也会发生：宿主进程没有操作系统权限 `stat` 的目录（`EACCES`）同样会重新抛出，而不是让遍历继续往上走。

## 决策

`existsAsMarker` 的错误分类现在把权限拒绝和"未找到"同等对待，两条路径都是如此：`isMissingProviderPathError` 现在也匹配 `FS_PERMISSION_DENIED`，`isMissingPathError` 现在也匹配 `EACCES`。对 `findProjectRoot` 而言，一次被拒绝的标记探测和一次未找到的探测意义相同——它都无法确认那里存在标记，因此继续往上爬——而且无论哪种情况，探测本身都不会透露任何存在性信息,所以容忍这次拒绝并不会泄露遍历原本就看不到的东西。其他任何错误（真正的 I/O 失败，比如 `EIO`，或者未被分类的 provider 错误）仍然会重新抛出，因为那些代表的是真正无法回答这次遍历的情况，而不是调用者本就该遇到的一道边界。

## 备选方案

### 为什么不只在 region-router 里修（让 `stat` 对所有边界拒绝都笼统地返回"未找到"）？

团队壳工作区隔离那份笔记明确把"`stat` 拒绝 `workspaceRoot` 之外的路径"记录为有意为之的行为，其他本地调用者也可能依赖这次拒绝以错误的形式可见,而不是被悄悄地变成"未找到"。把分类逻辑的修复放在标记探测调用者这一侧，既保住了 fs 接缝已声明的约定，又让唯一一个按设计要向上遍历、且没有理由区分"被拒绝"和"不存在"的调用者变得能够容忍它。而宿主侧的 `EACCES` 需要完全相同的处理，却根本不在 region-router 的管辖范围内——放在调用者这一侧修，正好能统一覆盖这两种情况。

### 为什么不让 `findProjectRoot` 在第一次遇到拒绝时就停止往上爬？

如果就此停下，即便再往上某个祖先目录确实持有项目根、而且本身完全可读，也会被悄悄地退回到 `cwd`——这从遍历的视角看，和"被拒绝的那一级本来就没有标记"是没法区分的。继续往上爬（把拒绝当作"这一级没有标记，继续走"）和遍历已有的"未找到"处理方式保持一致,也让它依然能在一个不可访问的目录之上找到项目根——这正是本次报告的场景所需要的结果。

## 后果

- 团队壳会话的基线 instruction 发现,在其默认的向上遍历跨出账户 `workspaceRoot` 边界时,不再让整轮对话崩溃;现在它会像那一级本来就没有标记一样,在边界处或边界之下找到项目根。
- 宿主进程无法 `stat` 的目录（`EACCES`）在遍历过程中同样会被容忍，而不是中止 instruction 发现。
- 其他任何 stat 失败（真正的 I/O 错误，或者不是 `FS_NOT_FOUND`/`FS_PERMISSION_DENIED` 的 provider 错误）仍然会继续传播、中止遍历，对真正的失败保留了原有的"暴露标记查找失败,而不是跨入祖先项目"的行为。
- `packages/context/agent-instructions/tests/agent-instructions.spec.ts` 中的回归测试覆盖：每条路径各一个测试（provider 端的 `FS_PERMISSION_DENIED`、宿主端的 `EACCES`）确认遍历现在会跨入祖先项目而不是抛出异常，同时保留（并各自新增一个）真正失败的测试，确认真实错误仍然会抛出。
