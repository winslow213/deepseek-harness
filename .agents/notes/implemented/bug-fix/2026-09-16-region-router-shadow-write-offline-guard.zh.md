# Agent 笔记：没有存活挂载时，shadow 树写入会静默落到本地磁盘

状态：已实现

[English](2026-09-16-region-router-shadow-write-offline-guard.md) | 中文

## 问题

`RegionRouterFileSystem.writeText`/`editText`（`shell/src/remote/region-router.ts`）都会先解析 `shadowTarget(target)`；解析出结果时，操作会被转发给对应的远程 agent。解析结果为 `undefined` 时，两个方法都会直接落到继承来的**本地**文件系统实现（`super.writeText`/`super.editText`），没有任何进一步检查。

对于读操作而言，未匹配到存活挂载时退回普通本地语义是正确的、已有文档记录的行为（见 `2026-09-16-region-router-shadow-probe-permission.md`）：那种情形下读不到内容本就无害，路径要么确实不存在，要么调用方只是在向上遍历、越过某个挂载边界寻找标记文件。写操作没有对应的安全解释：只要该路径对应的 agent 离线、还没配对，或者以不同的 root 重新配对过，`shadowTarget` 就会返回 `undefined`，而在这些情形下调用方都以为自己在写挂载的那台机器。退回本地写入，等于悄悄地在服务器磁盘上、这个 shadow 路径下创建了真实文件——这些内容从未真正发到远程根目录，模型和用户却都以为它们已经在那儿了。这种情况在多个会话里未被察觉地累积，直接在服务器 `/tmp/dsh-shadow/<user>/<agentId>/...` 下堆出了数百 MB 的真实项目内容，跟配对机器的真实状态完全脱节。

## 决定

新增 `assertShadowWriteRoutable(target)`：如果 `target.displayPath` 位于 shadow 根目录之下（`isShadow`）且 `shadowTarget` 没能解析出存活挂载，就抛出 `FsError(..., 'FS_IO_ERROR')`，信息中点明对应 agent 离线/未配对，而不是退回 `super.writeText`/`super.editText`。完全在 shadow 根目录之外的路径不受影响，继续保持普通本地写语义——这与读侧的不对称是刻意的：读操作把"无法路由"当作"未找到"处理，因为这是安全的默认值；写操作把它当作硬失败处理，因为把字节默默写到错误的机器上并不安全。

## 考虑过的替代方案

### 为何不让写操作也像读操作一样"软失败"（比如排队缓存，等 agent 重连后再补发）？

调用方以为写成功了，实际上只是被排队而未真正送达，这比本笔记要修的问题更危险、更隐蔽——模型会认为刚"写入"的内容已经在远程机器上，进而在后续只能由远程 agent 执行的 shell 命令里引用它，而实际上服务器上的字节根本还没送出去。直接报错失败，能让调用方在 agent 重新上线后重试，或者如实说明当前挂载处于离线状态，而不是假装成功。

### 为何不在这次修复里顺带自动清理这个 bug 已经产生的本地残留文件？

受影响的路径（本次部署中 `/tmp/dsh-shadow/winslow/pairing@WH-D-010484A/` 下的 `hello`、`OH_Hap`、`test`）属于运维层面的运行数据，不是受版本控制的状态；清理它们是直接在受影响服务器上执行的运维操作，不是这次提交能够表达或校验的代码改动。

## 后果

- 对一个 agent 离线、未配对、或以不同 root 重新配对过的 shadow 路径执行写/编辑操作，现在会立即以 `FS_IO_ERROR` 失败，而不是在服务器本地磁盘上悄悄创建出脱节的内容。
- shadow 根目录之外的路径不受影响，继续保持继承来的本地沙箱写语义。
- 回归测试覆盖：`shell/tests/region-router.spec.ts` 对一个没有存活挂载的 shadow 路径执行写入，断言既抛出了 `FS_IO_ERROR`，也确认本地磁盘上没有生成任何文件。
- 修复前遗留的本地残留内容不会被这次代码改动自动清理；它是作为受影响部署上的一次性运维清理动作被移除的。
