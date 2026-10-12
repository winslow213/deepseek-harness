# Agent Note: Role-scoped shared directories for team-shell accounts

Status: implemented

[English](2026-10-10-role-scoped-shared-sandbox-roots.md) | 中文

## 问题

每个 team-shell 账号都被限制在各自的工作区内，而这层限制由若干相互独立的层实现。团队需要两个比单个账号更长寿的目录：一个运维共享，一个全体成员共享。要让其中一个可见，结果是需要打开三道各自独立的闸门，而当时只知道其中两道。

**写闸门**是 [`packages/sandbox/sandbox/src/roots.ts`](../../../../packages/sandbox/sandbox/src/roots.ts) 中的 `writableRoots()`，它返回工作区根加 `/tmp` 与 `tmpdir()`。`sandbox-policy` 的 `workspaceRoot` 为它提供输入，各 profile 方言再从结果派生各自的写法。

**读屏蔽**是同一模块中的 `readShield()`。它拒绝共享的用户根，只重新暴露某个账号自己的 home —— 因为各账号 home 是同一个目录下的兄弟项，否则受限 shell 可以 `cat` 到其他账号的 `.credentials.yaml`。它在文件系统层面并不是权限边界：本机上每个实例都以同一个 UID 运行，所以屏蔽是账号之间唯一的隔离机制。因此，一个沙箱可写的目录在被显式重新暴露之前，读同样被拒绝。

**文件系统闸门**是 team-shell 自己加的，在 sandbox 各包中没有对应物。`packages/fs/fs-sandbox` 只覆写了 `writeText` 与 `editText`，其 `checkedTarget` 完全没有读侧检查。team-shell 账号的 `ctx.fs` 来自 `region-router`，而它只针对 `workspaceRoot` 执行自己的读边界 —— 因此 `readText`、`stat`、`listDir`、`readBytes`、`streamText` 都会拒绝一个写闸门已放行的路径。只打开前两道闸门，得到的是一个 agent 能写入、随后又无法 `stat` 的目录，比不提供它更糟。

`dsh_users.role` 早已存在，类型上就有 `operator` 与 `member`。没有任何代码读它：账号服务里每一处查询只是把它透传，而 KB 的 `sync_from_dsh_users` 把自己那一列 role 写死。全部 43 行都是 `member`。

## 决策

**部署级映射 `TEAM_SHARED_ROOTS` 把目录分配给角色，provisioning 再按账号角色把它解析成沙箱与 `ctx.fs` 消费的三个环境事实。**

`TEAM_SHARED_ROOTS` 是一个 JSON 数组，元素为 `{ path, roles?, write? }`。`path` 接受 `<usersRoot>` 占位符，使部署无需重复写出自己的绝对根即可表达目录布局；没有 `roles` 的条目适用于所有角色，没有 `write` 的条目授予写权限，因此 `write: false` 就是部署表达"有意只读目录"的方式。`parseSharedRoots`（[`shell/src/shared-roots.ts`](../../../../shell/src/shared-roots.ts)）刻意宽容：映射格式错误时解析为空共享根并记录原因，而不是让 spawn 失败 —— 因为另一种后果是一个错误的环境变量使本机所有账号都无法启动。

**三个环境变量把解析结果送达子进程**，全部由 `teamChildEnv` 写入：

- `DSH_RW_ROOTS` —— 沙箱可写的共享目录。
- `DSH_READ_ALLOWED_ROOTS` —— 账号自己的 home 加上每个被授予的目录。可写的授予也必须可读，所以这个列表是前者的超集。
- `TEAM_SHARED_ROOTS` 原样透传，使子进程可以重新解析。

`writeTeamSandboxPatch` 把它们写进账号的 `cordis.patch.yml`，与 `readDeniedRoots` 并列 —— 这正是让被授予的目录能穿过读屏蔽可见的原因。那个文件是 **home 层** patch，而落在哪一层决定了覆盖能否存活：`ensureRegionRouter` 每次 provision 都整文件重写 `profiles/web/cordis.patch.yml`，只对"不再带着它写过的那个块"的文件让手（那样也就没有 region router 了），所以追加在 profile 层的按账号覆盖会在该账号下次启动实例时丢失；home 层则只按块 upsert，从不整文件重写。因此部署若要扩展某个角色的授予——或者要配置任何按账号的插件——都应写 home 层，而不是 profile 层。`readDeniedRoots` 与 `readAllowedRoots` 必须保持为单引号 YAML 标量：未加引号的 `!!js [` 值会被解析成流式序列，随后的 `.filter(...)` 会让整份 patch 失败，那是账号无法启动，而不只是屏蔽失效。

**`rwRoots` 加入 `SandboxExecutionPolicy`**，并由 `effectiveRwRoots()` 在任何方言看到它之前完成过滤。条目在以下情况被丢弃：不是绝对路径、等于 `/`、或是 mode 自有路径（`workspaceRoot`、`/tmp`、`tmpdir()`）本身或其祖先。最后这条不是整洁性问题：bwrap 方言把 `--bind` 追加到承载 `--tmpfs` 的同一段，而 bwrap 以最后匹配的挂载为准，因此绑定一个 mode 自有路径的祖先会静默替换该路径原有的处理，而不是在其之上追加。

**各方言在各自表达式需要的位置接入这些额外根**，而不是三者共用同一个 helper：

| 方言 | 改动 |
|---|---|
| bwrap | 在 mode 段追加 `--bind`；读已由 `--ro-bind / /` 提供 |
| landlock | 同时追加到 `readWrite` 与 `readOnly` |
| seatbelt、fs-sandbox、windows-acl | 无需改动 —— 它们已消费 `writableRoots()`/`readShield()` |

landlock 那条规则是最不直观的。配置了读屏蔽后，它的 `readOnly` 列表是严格的 allow-list，因此一个未被列入其中的被授予目录即便 `readWrite` 允许也仍然不可读。`readWrite` 没有收敛为消费 `writableRoots()`，因为那个 helper 还会返回 `tmpdir()`，而把写面扩大当作目录授予的副作用，是一处与需求无关的行为变化。

**`region-router` 为第三道闸门新增 `readableRoots` 配置字段**，并经 `InjectRegionRouterOptions` 与 `regionRouterPatchYaml` 接线，使被 spawn 的账号路由器在同一次 provisioning 中拿到它。`allowsLocalRead` 取代原先两个断言 helper，影子路径的提前返回仍位于边界检查之前。

**`disturbsShadowTree()` 丢弃会暴露影子根的授予。** 挂载影子树并不受沙箱约束：它由第三方插件经 `node:fs` 写入，也正是仪表盘遍历以列出成员挂载设备的对象。今天它对其他账号的隐藏只是偶然 —— `--tmpfs /tmp` 恰好擦除了整个 `/tmp`，而影子根位于 `/tmp/dsh-shadow`，同时 `readDeniedRoots` 并未列出 `/tmp`。一个覆盖 `/tmp` 或影子根任一祖先的授予，会一次性撤销所有账号的这层隔离。

**角色由账号服务读出。** `GET /api/accounts/<user>` 在既有的 `authorized()` 检查之后只返回角色，CLI spawn 路径（此前没有任何账号查询）通过 `fetchAccountRole` 读取它。查询失败只记录日志并继续以"无共享根"spawn：那条路径同时也是账号服务宕机时恢复账号的方式，拒绝启动会把一个服务故障变成整机故障。

## 考虑过的替代方案

**为共享目录建一张成员授权表。** 一张 `shared_roots` 表加一张授权表，可让运维在不改环境变量的情况下按账号分配目录。暂不采纳：角色这一维已经是全部需求，两个目录都是部署级常量，而授权表在带来收益之前还需要自己的读取路径、缓存失效与迁移。接缝保持敞开 —— 解析步骤的输入是角色与映射，将来可以由某个 provider 从数据库算出两者。

**所有角色共用一个目录。** 不采纳：那会抹掉需求本身要区分的差别。仅运维可见的目录正是把 runbook 与凭据挡在成员可见目录之外的东西，而一旦有任何运维专属内容落入其中，单一的全员可写共享根就得重新设计。

**Unix 组、setgid 与专用共享组。** 不作为方案采纳：在本机不成立 —— 每个实例都以同一个 UID 运行，没有任何 mode 位或组成员关系能区分它们。各账号 home 是 `700` 却同样不提供隔离，原因相同 —— 真正分隔账号的是沙箱读屏蔽，这也是共享目录需要屏蔽配合、而不是需要一次 `chmod` 的原因。

**把共享目录放在用户根之下，仅依赖 `<usersRoot>` 解析。** 不采纳：`readDeniedRoots` 覆盖整个用户根，而影子树防护之所以存在，正是因为一个位于被拒绝树内的重新暴露目录，恰恰也是可能一并吞掉影子根的形状。让这些目录位于各 home 之外、并按名字重新暴露，使两个列表彼此独立。

**让沙箱为读与写只消费单一的 `rwRoots`。** 不采纳：它把"可写"与"必须可读"混为一谈。一个授予完全可以可读而不可写，单一字段会让这无法表达。

**角色查询失败时让 spawn 失败。** 不采纳：见上文决策。一个没有共享目录的降级账号仍可用；一个无法启动的账号则不然。

## 后果

账号现在能看到一个公共目录，当其角色为 `operator` 时还能看到一个管理员目录，并且从 shell 与文件系统工具都可达。三道闸门被一并覆盖：`packages/sandbox/sandbox/tests/roots.spec.ts` 覆盖丢弃规则与影子防护，`packages/sandbox/sandbox-local/tests/local.spec.ts` 覆盖 bwrap 与 landlock 的参数列表，`shell/tests/region-router.spec.ts` 覆盖读边界，`shell/tests/shared-roots.spec.ts` 与 `shell/tests/spawn-user-sandbox.spec.ts` 覆盖映射解析与 spawn 交给子进程的按角色环境。

代价是多了一处决定沙箱可以触碰什么的地方，以及一个失败方式是沉默的映射：`path` 写错会得到零个共享根与一行日志，而不是一个错误。对此的兜底是解析后的列表在每个账号的 `cordis.patch.yml` 中可见，运维可以读到某个角色实际产出了什么。

共享根只存在于服务器上。`region-shell` 按 workdir 分流，若某账号的 workdir 是挂载的影子路径，其命令会被转发到成员自己的机器，而这些目录在那里都不存在。文件系统工具仍可通过本地分支访问它们，因此 agent 可以读写共享文件，而同一会话中的 shell 命令却看不到它。本次改动没有解决这一分裂。

授予同样是在 provisioning 时而非使用时校验的：部署规则是共享根不得是影子根的祖先，而该检查在解析映射处执行。若某部署日后把影子根移到它已经授予过的目录之下，就需要一次新的 provisioning，防护会跟随环境所指定的那个影子根。
