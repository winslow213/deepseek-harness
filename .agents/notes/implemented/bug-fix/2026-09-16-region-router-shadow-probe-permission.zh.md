# Agent Note: `assertLocalReadable` 把任何影子路径都当作普通本地探测处理

Status: implemented

[English](2026-09-16-region-router-shadow-probe-permission.md) | 中文

## 问题

`RegionRouterFileSystem`（`shell/src/remote/region-router.ts`）对每一个本地（非远程）路径都会做工作区边界检查，这个检查由两个并行的私有方法实现：`assertLocalPathReadable(abs)`（只被 `lstat` 使用）和 `assertLocalReadable(target)`（被 `stat`、`readText`、`readBytes`、`readByteRange`、`listDir` 使用）。只有前者已经对影子根目录（`isShadow(abs)`）下的任意路径跳过了这道检查；后者只在路径对应*当前存活*的挂载时才跳过（`shadowTarget(target) !== undefined`），否则会抛出 `FS_PERMISSION_DENIED`。一个在影子根目录下、既不是账户私有工作区又不是存活挂载的路径——比如某个调用者从挂载目录向上遍历寻找仓库根标记时产生的 `/tmp/dsh-shadow/<user>/.git`，或是早先某次用不同 root 配对时留下的目录——正好落在这个未匹配的情形里。由于 `stat` 是一个普通的存在性探测（不像 `lstat` 那样已经能容忍这种情况），这个不对称之处就表现为一个硬性的类似 `path outside allowed roots` 的崩溃，导致整轮对话失败，而不是一个普通的"未找到"。

## 决策

`assertLocalReadable` 现在也会在 `this.isShadow(target.displayPath)` 为真时跳过这道检查，与 `assertLocalPathReadable` 已有的行为完全一致。一个未匹配的影子路径既不是账户的私有工作区，也不是存活挂载，因此把它当作普通的本地未命中来处理（让 `stat` 返回 `undefined`、`readText`/`readBytes` 抛出 `ENOENT` 等）是安全的：它仍然局限在同一个账户自己的历史影子目录内，绝不会涉及另一个租户的数据，这个改动只是把对"未找到"内容的探测变成真正的"未找到"响应，而不再是权限错误。

## 备选方案

### 为什么不把跳过范围限定为只针对当前存活挂载的那个确切影子路径？

`shadowTarget(target) !== undefined` 正是这样一个精确的、感知当前存活挂载的检查，`assertLocalReadable` 也仍然把它保留为第一优先的跳过条件。问题恰恰出在那些没能通过这个精确检查、却仍然位于宽泛影子根目录之下的路径——早先某次配对留下的残留，或者调用者越过当前存活 root 向上遍历时产生的路径。再进一步收紧范围，只会把这份笔记要修的崩溃原封不动地留在那里。

### 为什么不让调用者自己避免探测挂载 root 之上的路径？

本次报告中触发失败的探测是一次通用的向上目录遍历（比如定位 `.git` 标记），它并不知道、也没有理由知道影子树的边界；改变这类调用者的行为既不现实，也不属于这次修复的职责范围。对于 region-router 自己不拥有的路径，"未找到"应该意味着什么，应该由 region-router 的这道边界检查自己来决定。

## 后果

- `stat`、`readText`、`readBytes`、`readByteRange`、`listDir` 现在对影子根目录下的任意路径都和 `lstat` 表现一致，无论它是否对应当前存活的挂载。
- 调用者从挂载目录内部向上遍历（例如定位 `.git` 标记）时，一旦越过当前配对的 root，不再导致整轮崩溃，而是观察到普通的"未找到"语义。
- 早先用不同 root 配对时留下的影子目录残留（在单独清理之前仍然存在于 `/tmp/dsh-shadow/<user>/<agentId>/...` 下）同样会被当作普通本地内容来探测，而不是直接拒绝。
- 回归测试覆盖：`shell/tests/region-router.spec.ts` 解析一个没有存活挂载匹配的影子路径，并断言 `stat()` 返回 `undefined` 而不是抛出异常。
