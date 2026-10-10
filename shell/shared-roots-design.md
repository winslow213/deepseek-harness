# DSH 沙箱共享目录（按角色的公共可写根）设计方案

> **性质**：方案稿，供审查后由实现方落地。
> **目标**：按账号**角色**授予服务器上的公共可读写目录——管理员一个，普通成员一个。
> **日期**：2026-10-10 ｜ **依据**：`feature-dynamicui`（`5eb922e40c`，与生产一致）源码级核实，均带 `文件:行`。
>
> **文档归属**：本文件是该特性的设计稿。影子目录的定义、生产根值等既有事实以
> [`design.md`](design.md) §13 为唯一家，本文只引用不重述。落地时按根 `AGENTS.md`
> 另需一条 Agent Note（涉 `packages/sandbox/` 的公开 seam，属"非机械改动"）。

---

## 1. 需求

| | 目录 | 谁可见 | 谁可写 |
|---|---|---|---|
| 管理员共享 | `~/.dsh-users/shared/admin` | winslow、tucker | winslow、tucker |
| 成员共享 | `~/.dsh-users/shared/common` | **全部 43 个账号** | **全部 43 个账号** |

管理员取**超集**（两个目录都有）；其余 41 个成员只有 `common`。

### 1.1 角色模型（实测）

```
dsh_users.role                  TEXT NOT NULL DEFAULT 'member'
shell/src/account/users.ts:11   role?: 'operator' | 'member'

实测生产值：43 行全部 = 'member'，零个 'operator'
            winslow = member（idle_exempt=true）、tucker = member
```

**`role` 目前只被存储和展示，从不参与任何判定。** 全量确认：`db.ts:55,77`、
`http.ts:154,258`、`auth.ts:38` 只是把它透出给前端，没有任何
`role === 'operator'` 分支。代码里出现的 "operator" 一律指**跑部署的那个人**，
不是 DB 角色。

因此本方案是该字段**第一次真正生效**。

### 1.2 为什么放在 `~/.dsh-users/` 下

不是图方便，是**唯一能实现"管理员目录对成员不可见"的位置**。

当前沙箱对读的处理是两个极端：

| 位置 | shell 命令 | 模型文件工具 |
|---|---|---|
| 屏蔽根**之外**（如 `/srv/dsh-share`） | 整盘 `--ro-bind / /` → **所有账号都可读** | 被 `region-router` 读闸门拒绝 |
| 屏蔽根**之内**（`~/.dsh-users`） | `--tmpfs` 擦除 → **看不见** | 被 `region-router` 读闸门拒绝 |

即：**放在屏蔽根之外，管理员目录对 41 个成员是"可读"的**（shell 能 `cat`），
要藏起来得再引入一个读屏蔽维度。放在屏蔽根之内则由既有的 `--tmpfs` 天然承担。

```
读屏蔽根    ~/.dsh-users       （= DSH_USERS_ROOT；生产未显式设置，
                                回落 dirname(home)，实测即此值）
角色可见性   由各账号 readAllowedRoots 重新暴露哪些子目录决定
```

### 1.3 非目标

| 不做 | 理由 |
|---|---|
| 每用户 × 每目录的细粒度授权表 | 需求是**按角色**分，用 role 即可；多一层表是过度设计 |
| 文件级 / 子目录级授权 | bwrap `--bind` 是目录级，表达不了 |
| 运行期热加载授权 | `cordis.patch.yml` 历来"provision 时写、spawn 时读"，无热加载先例 |
| 跨机器共享 | 见 §6.2 |
| Windows ACL 支持 | §6.4 |
| 读权限细分（"某成员不可读某公共目录"） | 当前需求只要求角色级可见性，本方案机制已覆盖 |

---

## 2. 现状（实测）

### 2.1 三道互相独立的闸门

共享根要真正可用，**三道都要开**。这是本方案最容易做漏的地方。

| # | 闸门 | 位置 | 谁受它管 | 现状允许集 |
|---|---|---|---|---|
| **G1** | **写** | `roots.ts:52` `writableRoots()` | shell 命令（经 bwrap/landlock/seatbelt）**与** `ctx.fs`（经 `checkedTarget`） | `workspaceRoot` · `/tmp` · `tmpdir()` |
| **G2** | **读（shell）** | `roots.ts:71` `readShield()` | shell 命令 | 整盘（`--ro-bind / /` / `(allow default)`）；屏蔽根须重新暴露 |
| **G3** | **读（模型文件工具）** | `region-router.ts:194,207` | `ctx.fs` 的 7 个读方法 | **仅 `workspaceRoot`** |

**G3 是我们自己加的**，stock `fs-sandbox` 只管写不管读：

```js
// packages/fs/fs-sandbox/src/index.ts —— 只覆写这两个（皆写操作）
override async writeText(...)   // :80
override async editText(...)    // :101
// checkedTarget(:122) 只做写包含检查，没有任何读侧判定
```

而 `region-router.ts:53-57` 的注释把这条读边界写成了契约：

> *The account's private workspace directory — **the only local path this instance
> may READ** besides its mounted shadow roots.*

**推论**：共享根若放在 `~/.dsh-users`（不在 `workspaceRoot` 下），
**即使 G1 与 G2 都开了，模型的文件工具依然读不到**——被 `FS_PERMISSION_DENIED`
挡掉。

### 2.2 写路径与读路径的不对称

| 方法 | 过 G3 读闸门？ |
|---|---|
| `stat` `:224` · `lstat` `:238` · `readText` `:249` · `streamText` `:273` · `readBytes` `:286` · `readByteRange` `:307` · `listDir` | ✓ |
| `writeText` `:328` · `editText` `:356` | ✗（只走 `assertShadowWriteRoutable` + 继承的 `checkedTarget`） |

因此**只开 G1 不开 G3** 会出现"能写但 `stat` 不了"的怪状态（写入前的 `stat`
就先被拒）。**两道必须一起开**，验收要覆盖。

### 2.3 五个强制消费方

| 消费方 | 位置 | 消费 `writableRoots()` |
|---|---|---|
| seatbelt（darwin） | `sandbox-local/src/profiles.ts:104` | ✓ |
| fs-sandbox | `fs/fs-sandbox/src/index.ts:134` | ✓ |
| bwrap（linux 首选） | `sandbox-local/src/profiles.ts:32` | ✗ 自拼 `--bind` |
| landlock（linux 回退） | `sandbox-local/src/profiles.ts:78` | ✗ 自拼 `readWrite` |
| windows-acl（win32 唯一档） | `PLATFORM_CHAINS.win32 = ['windows-acl']` | ✗ 从 `workspaceRoot` 派生 SID |

前两个消费 helper → **改 helper 即自动生效**；后三个各自拼写，是漂移风险所在。

### 2.4 本部署实际挂载的 provider

实测每账号 `<home>/profiles/web/cordis.patch.yml`：

```yaml
- id: fs-sandbox      # disabled: true  → 换 region-fs
- id: bash-sandbox    # disabled: true  → 换 region-shell
- id: pwsh-sandbox    # disabled: true  → 换 region-shell
```

生产服务器 **Linux 6.8 / x86_64，bwrap 0.6.1** → **bwrap 是生效方言**。

`RegionRouterFileSystem extends SandboxedFileSystem`（`region-router.ts:91`），
所以模型文件工具的本地路径仍走 `checkedTarget` → `writableRoots()`（G1 链有效），
但**多了一道 G3**。**验收必须在 team-shell profile 下跑**。

### 2.5 生产实际策略值

```yaml
mode:             !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
workspaceRoot:    !!js process.env.DSH_WORKSPACE_ROOT        # <home>/workspace
readDeniedRoots:  !!js '[process.env.DSH_USERS_ROOT].filter(Boolean)'   # ~/.dsh-users
readAllowedRoots: !!js '[process.env.DSH_HOME].filter(Boolean)'         # 本账号 home
```

`readDeniedRoots` **不含 `/tmp`**，而生产影子根是 **`/tmp/dsh-shadow`**——
两个事实在 §5.2 撞车。

### 2.6 UID 与权限（实测）

```
~/.dsh-users           drwxrwxr-x (775)  winslow:winslow
~/.dsh-users/darcy     drwx------ (700)
所有 dsh 实例进程        UID 1000 GID 1000（同一个 winslow）
```

**所有实例同一个 UID** → 700 不提供任何账号间隔离。
**读屏蔽（G2 的 `--tmpfs`）是账号之间唯一的 shell 层隔离，没有第二道。**

同时这也意味着**共享目录不需要任何 OS 权限调优**（§3.7）：
`mkdir` 出来的 755 目录同 UID 直接可写，无需共享组 / setgid / umask。

---

## 3. 设计

### 3.1 角色到目录的映射

映射是**部署配置**，不是硬编码（根 `AGENTS.md`：deployment-varying choices 是
可校验的 Config，`DEFAULT_*` 常量不算可配置）。

```
TEAM_SHARED_ROOTS = JSON 数组
[
  { "path": "<usersRoot>/shared/common", "roles": ["operator", "member"], "write": true },
  { "path": "<usersRoot>/shared/admin",  "roles": ["operator"],           "write": true }
]
```

本部署已采用上面这一组取值（两个目录、管理员专属 + 全员共用，各自建在
`~/.dsh-users/shared/` 下）。

- `path` 支持 `<usersRoot>` 占位符，避免在配置里重复写绝对路径
- `roles` 缺省 `["operator", "member"]`（即全员）
- `write: false` 表示**有意只读**：它不缩小任何既有读权限，存在的意义是让配置
  显示意图；写侧不纳入 G1
- **映射为空时，provision 结果与改造前逐字节相同**

每个账号解析出两组路径：

```
operator → 读/暴露: [home, common, admin]    写: [common, admin]
member   → 读/暴露: [home, common]           写: [common]
```

### 3.2 三个闸门的接入

| 闸门 | 接入方式 | 谁自动受益 |
|---|---|---|
| **G1 写** | `rwRoots` 并入 `writableRoots()`；bwrap mode 段追加 `--bind`；landlock `readWrite` 追加 | fs-sandbox、seatbelt 自动；bwrap/landlock 各一处 |
| **G2 读（shell）** | 共享根并入 `readAllowedRoots`（即 `readShield().allowed` 的过滤前输入） | bwrap、seatbelt 自动；landlock 另需 `readOnly`（§3.3） |
| **G3 读（ctx.fs）** | `region-router` 新增 `readableRoots`，并入两个 `assertLocal*Readable` 的允许集 | 单点 |

### 3.3 三方言推导（按读写两类，不按方言特判）

| 方言 | 写侧 | 读侧 | 需要改哪里 |
|---|---|---|---|
| **fs-sandbox** | `writableRoots()` ✓ 自动 | — | **无** |
| **seatbelt** | `writableRoots()` ✓ 自动 | `(allow default)`；屏蔽根另加 `deny`/`allow` | **无** |
| **bwrap** | 自拼 `--bind` | `--ro-bind / /` 全盘只读；屏蔽根内由 shield 段 `--ro-bind` | **mode 段追加 `--bind`** |
| **landlock** | 自拼 `readWrite` | 有屏蔽时 `readOnly` 是**严格 allow-list** | **`readWrite` 与 `readOnly` 各追加** |
| **windows-acl** | ✗ | — | **无**（§6.4） |

**seatbelt 零改动**：它同时消费 `writableRoots()`（写）与 `readShield()`（读），
改 helper 即自动正确。其注释已说明竞争规则：

> *Seatbelt resolves competing rules by taking the LAST match, so the broad
> read denial must come before the re-exposure of the tenant's own subtree.*

**bwrap 只需写侧**：全盘 `--ro-bind` 已保证可读；屏蔽根内的由 shield 段的
`--ro-bind` 重新暴露，而 shield 段**本就 emit 在 mode 段之前**
（`profiles.ts:18-28` 注释原文）：

> *the shield is emitted BEFORE the mode's own mounts: a workspace that lives
> inside a denied root must be bound back writable afterwards*

所以 mode 段的 `--bind` 天然排在 shield 之后 → last-wins → 可写 ✓。

**landlock 是唯一需要"无条件"补读侧的地方**，因为它的 `readOnly` 在有屏蔽时被
替换成"系统根 + 重新暴露的子路径"（`profiles.ts:69-74` 注释原文）：

> *Landlock expresses allow-lists only, so it cannot subtract a path from a
> blanket grant. With one, the blanket grant is replaced by the system roots
> plus the re-exposed subtrees*

因此即便共享根在屏蔽根**之外**也**不可读**。这不是 bwrap/seatbelt 的性质，只有
landlock 有。

**接入点共 5 处**：

| # | 位置 | 改动 |
|---|---|---|
| 1 | `writableRoots()` | 并 `effectiveRwRoots(policy)` |
| 2 | `readShield()` 的 `allowed` **过滤前**输入 | 并 `effectiveRwRoots(policy)` |
| 3 | bwrap mode 段 | 每项追加 `--bind root root` |
| 4 | landlock `readOnly`（有屏蔽时） | 并 `effectiveRwRoots(policy)` |
| 5 | landlock `readWrite` | 并 `effectiveRwRoots(policy)` |

**接入点 2 为什么可行**：`readShield` 已有过滤（`roots.ts:74-76`）——allowed 中
不在任何 denied 之内的项**被丢弃**。把共享根追加到**过滤前**的输入：

- 在 denied **内**（本方案的情形）→ 保留 → seatbelt `(allow file-read*)`、bwrap `--ro-bind` ✓
- 在 denied **外** → 被丢弃 ✓（该处本来就可读，无需动作）

**landlock 的 `readWrite` 不收敛为消费 `writableRoots()`**：现有拼写是
`['/dev/null']` +（`workspace-write` 时 push `/tmp`、`workspaceRoot`）
（`profiles.ts:79-81`），收敛会**顺带**给 landlock 增加 `tmpdir()` 的写权限——
与本需求无关的行为变化。只**追加**。

### 3.4 `effectiveRwRoots` —— 模式闸门 + 安全丢弃

新增导出函数，作为该字段含义的**唯一家**（与 `writableRoots` / `readShield` 同构）：

```
// 同文件内 isUnder（roots.ts:80）已就位；需新增 node:path 的 isAbsolute 导入。
// 发布时带完整 JSDoc：只表写不表读、缺省即历史语义、仅 workspace-write 生效、
// 是授权不是隔离、丢弃只会减少权限因此 fail-closed。
export function effectiveRwRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  const modeOwned = writableRoots(policy)          // workspaceRoot, /tmp, tmpdir()
  return [...new Set((policy.rwRoots ?? []).map(canonicalPath))]
    .filter(root => isAbsolute(root))
    .filter(root => root !== '/')
    .filter(root => !modeOwned.some(owned => isUnder(owned, root)))
}
```

丢弃规则逐条理由：

| 条件 | 后果（若不丢） |
|---|---|
| 非绝对路径 | `canonicalPath` 对相对路径无确定行为；拼进 profile 无意义 |
| `'/'` | 全盘可写，等于 `danger-full-access` |
| 是 `/tmp` / `tmpdir()` / `workspaceRoot` 的**祖先或本身** | bwrap 的 `--bind` 会**整体替换** mode 段的 `--tmpfs`，把该 tmpfs 想隐藏的东西全部重新暴露（§5.2） |

**语义四条**（写进 JSDoc）：只表写不表读；缺省即历史语义（`undefined`/空数组 ==
改造前）；仅 `workspace-write` 生效；**是授权不是隔离**。

### 3.5 G3：`region-router` 新增 `readableRoots`

```ts
// shell/src/remote/region-router.ts  Config 追加
/**
 * Additional local roots this instance may READ besides `workspaceRoot`.
 * The team shell grants role-scoped shared directories here; each entry is an
 * explicit grant, so an absent list keeps the single-root boundary.
 */
readableRoots?: readonly string[]
```

两处判定各加一个 `some`：

```ts
private allowedLocalRead(path: string): boolean {
  const root = this.region.workspaceRoot
  if (root !== undefined && isLexicallyUnder(path, root)) return true
  return (this.region.readableRoots ?? []).some(r => isLexicallyUnder(path, r))
}
```

`assertLocalReadable`（`:194`）与 `assertLocalPathReadable`（`:207`）都改为调用它；
`root === undefined` 时保持既有"读任意"语义不变。

> 一致性提示：`region-router.Config extends SandboxedFsConfig`（`:46`），
> 追加的是可选字段，不改继承面。

### 3.6 逐账号注入（同步接缝）

`teamChildEnv(home, supervised)` **是同步函数**（`spawn-user.ts:626`），
不能在 spawn 时查库。但 **`instance-manager.start()` 已经取了账号对象**——
现在为 KB 令牌：

```ts
// shell/src/account/instance-manager.ts:184
const account = await this.options.users.findByUsername(userId)
const instance = superviseUserInstance(userId, port, {
  agentToken: account?.agent_token,   // ← 既有
  role: account?.role,                 // ← 本方案新增（同一行的事）
  ...
})
```

**不需要新的物化文件通道**：`role` 顺着既有的账号事实参数链传下去即可
（与 `agentToken` 完全同构）。

```
instance-manager.start(userId)                     异步：拿到 account.role
   ↓ role
provisionUserHome(user, env, { agentToken, role }) 同步
   ↓
writeTeamSandboxPatch(home)              写 patch：rwRoots + readAllowedRoots 两行
                                         （列表值来自 env，见下）
teamChildEnv(home, supervised, role)     env：DSH_RW_ROOTS / DSH_READ_ALLOWED_ROOTS
```

`writeTeamSandboxPatch` 只写表达式、不写值：值由 `teamChildEnv` 按角色解析后经
环境传给子进程，patch 在子进程启动时求值。这样 patch 文本对所有账号一致，角色差异
只活在环境里。

patch 两行都改成 env 驱动（该块已有 `!!js` 先例）：

```yaml
    rwRoots: !!js JSON.parse(process.env.DSH_RW_ROOTS ?? '[]')
    readAllowedRoots: !!js JSON.parse(process.env.DSH_READ_ALLOWED_ROOTS ?? '[]')
```

`readAllowedRoots` 由 `[DSH_HOME]` 扩为 `[DSH_HOME, ...共享根]`。
`readDeniedRoots` 不变（仍是 `DSH_USERS_ROOT`）。

**选 JSON 数组而非分隔符**：路径可含空格与分隔符本身，跨平台无歧义。

**配置解析必须宽容**：`TEAM_SHARED_ROOTS` 缺失 / 非 JSON / 元素形状不对 →
**当作空映射**（无任何共享根），既不放宽权限也不拉不起实例。

### 3.7 目录创建与命名

三个目录由运营流程保证存在（`canonicalPath` 对不存在路径回落原拼写，
**授权但不生效且不报错**——`roots.ts:25-29` 注释明写这是刻意的保守行为）：

```bash
mkdir -p ~/.dsh-users/shared/admin ~/.dsh-users/shared/common
# 同 UID，无需共享组 / setgid / umask（见 §2.6）
```

**命名约束**：`spawn-user.ts:123` 的 `listBotConnectedUsers()` 会
`readdirSync(usersRoot)`，把每个目录名当候选账号 id 再查 `<user>/integrations/`。
`shared` 没有 `integrations` → 返回 `false`，**无害**（只多一次 stat）。
但为避免混淆，`shared` 必须**不与任何账号名冲突**，且文档须写明它非账号目录。

**清理语义**：`shared/` 不属于任何账号，**不得**随账号清理（`rmSync <home>`）
或 users root 重建而删除。运营流程须单独对待。

---

## 4. 改动清单

| # | 位置 | 改什么 | 为什么 |
|---|---|---|---|
| 1 | `packages/sandbox/sandbox/src/index.ts` | `SandboxExecutionPolicy` 加 `rwRoots?` + JSDoc（§3.4） | 契约类型面 |
| 2 | `packages/sandbox/sandbox/src/roots.ts` | 新增 `effectiveRwRoots()`；`writableRoots()` 与 `readShield()` 各接一处 | G1 与 G2；两处接入消掉 3 个消费方的漏改 |
| 3 | `packages/sandbox/sandbox-local/src/profiles.ts` | bwrap mode 段追加 `--bind`；landlock `readOnly` 与 `readWrite` 各追加 | 两个自拼方言（§3.3） |
| 4 | `packages/sandbox/sandbox-policy/src/index.ts` | Config 加 `rwRoots`；类字段 + 构造赋值；`resolve()` 空则省略 | 配置入口 |
| 5 | **`shell/src/remote/region-router.ts`** | Config 加 `readableRoots`；两处 `assertLocal*Readable` 改用统一 allow 判定 | **G3** |
| 6 | `shell/src/remote/inject.ts` | `regionRouterPatchYaml` / `injectRegionRouter` 透出 `readableRoots` | 让 G3 的配置到达 profile |
| 7 | `shell/src/spawn-user.ts` | ① `TEAM_SHARED_ROOTS` 解析（宽容）<br>② 按 role 解析路径<br>③ `teamChildEnv` 注入两个 env<br>④ patch 追加 `rwRoots` 行并扩 `readAllowedRoots` | 逐账号注入 |
| 8 | `shell/src/account/instance-manager.ts` | 传 `role: account?.role` | 角色来源 |
| 9 | `shell/src/account/cli.ts` | 若缺 `set-role`，补一个（现只有 create 时的 `--operator`） | 把 winslow/tucker 设为 operator |
| 10 | `packages/sandbox/sandbox/tests/roots.spec.ts` | 补用例 | 已有该文件 |
| 11 | `packages/sandbox/sandbox-local/tests/*`、`shell/tests/*` | 补用例 | |

**不改**：`packages/fs/fs-sandbox`（消费 `writableRoots()` → 自动）、
seatbelt 段（消费两个 helper → 自动）、`region-shell`（非影子 workdir 自动走本地
沙箱分支）、`sandbox-windows-acl`（§6.4）。

---

## 5. 风险

### 5.1 风险清单

| # | 风险 | 说明与处理 |
|---|---|---|
| ① | **挂载顺序** | bwrap `--bind` 必须落在 shield 段之后 → mode 段本身就在其后，天然满足（§3.3）。验收须显式覆盖 |
| ② | **landlock allow-list** | 有屏蔽时 `readOnly` 是严格 allow-list → 接入点 4（§3.3） |
| ③ | **mode 段 tmpfs 被撤销** | 见 §5.2。§3.4 的丢弃规则作为通用兜底 |
| ④ | **windows-acl 不消费** | §6.4。本部署不受影响，声明为已知边界 |
| ⑤ | **目录级无文件级** | bwrap `--bind` 表达不了更细粒度。**授权不是隔离**：拿到同一目录的两个账号可互相覆盖 |
| ⑥ | **符号链接** | `shared/` 内可创建指向别处的链接。`--tmpfs` 擦除会把指向同级账号的链接**解析到空目录**（→ 不存在），间接限制了一部分；但指向屏蔽根**之外**的链接仍会生效，写操作会跟随。→ 声明威胁模型依赖 OS 权限兜底 |
| ⑦ | **同步/异步接缝** | §3.6。`role` 经既有参数链传递，无需新建通道 |
| ⑧ | **目录必须先存在** | §3.7。授权但不生效且不报错 |
| ⑨ | **生效方式** | patch 在 provision 时写、spawn 时读。**角色或映射变更需重新 provision / 重启实例**。维持既有模型 |
| ⑩ | **本部署未挂 stock provider** | §2.4。**验收必须在 team-shell profile 下跑**，否则验的不是生产形态 |
| ⑪ | **写读不对称** | §2.2。只开 G1 不开 G3 → "能写但 stat 不了"。两道一起开 |
| ⑫ | **`shared` 被误当账号** | §3.7。`listBotConnectedUsers` 会见到它（无害），但不得与账号名冲突 |

### 5.2 部署规则：不要授权 `/tmp` 系

生产影子根在 `/tmp/dsh-shadow`，`readDeniedRoots` **不含 `/tmp`**，
而沙箱 `workspaceRoot` 跟随 session cwd，所以挂载会话的 `workspaceRoot` 就是它
自己的影子路径。bwrap mode 段：

```
--tmpfs /tmp                                   ← 把 /tmp 换成【空】tmpfs
--bind <workspaceRoot> <workspaceRoot>         ← 只把本会话自己的影子路径 bind 回来
```

**今天的挂载隔离是这么意外得到的**：`--tmpfs /tmp` 抹掉整个 `/tmp`，其他账号的
影子目录随之不可见。bwrap 是 **last-wins**，所以**任何 `/tmp` 或
`/tmp/dsh-shadow` 的祖先被 `--bind`，这层隔离就被整体撤销**，而
`readDeniedRoots` 根本不覆盖 `/tmp/dsh-shadow`。

本方案的共享根是 `~/.dsh-users/shared/*`，**不在 `/tmp` 下** → 不触发。
§3.4 的丢弃规则（mode-owned 路径的祖先）作为通用兜底。

---

## 6. 与既有机制的交互

### 6.1 读屏蔽（G2）

共享根在 `readDeniedRoots`（`~/.dsh-users`）**之内** → 必须进 `readAllowedRoots`
才可读。bwrap 的读由 shield 段 `--ro-bind` 提供、写由 mode 段 `--bind` 提供，
顺序天然正确（§3.3）。landlock 另需接入点 4。

### 6.2 挂载工作区

**① `--tmpfs /tmp` 与影子根撞车**：见 §5.2。

**② 语义分裂**：共享根只存在于**服务器**文件系统。`region-shell` 按 workdir 分流
（`region-shell.ts:130-145`）：影子树内的 workdir → 转发到用户机器的 agent。

| 操作 | 走哪条路 | 共享根在哪 |
|---|---|---|
| 文件工具访问共享根 | `ctx.fs`，非影子路径 → 本地分支 | 服务器 ✓ |
| 以共享根为 cwd 跑命令 | 本地沙箱分支 | 服务器 ✓ |
| **在影子工作区里跑命令** | **转发到用户自己的机器** | **不存在** ✗ |

即：挂载会话里模型的文件工具能用共享根，但**在影子 cwd 下执行的命令行看不到它**。
这是需求的必然（每个 agent 只服务自己那台机器，不存在共同文件系统），不是缺陷，
但必须写进面向用户的说明，否则会有"我的共享目录怎么是空的"。

**③ G3 的改动不得影响影子路径**：`assertLocalReadable` 对影子路径本就先返回
（`:195`），新增的 allow 判定必须排在那个早返回**之后**。

### 6.3 与 `read-only` / `danger-full-access`

`effectiveRwRoots` 在非 `workspace-write` 一律返回空（§3.4）。
`read-only` 下共享根**不可写**（符合模式语义）；`danger-full-access` 下整盘本就可写，
无需共享根。**两种模式下读侧行为不变**（读权限不由本方案收窄）。

### 6.4 windows-acl

`PLATFORM_CHAINS.win32 = ['windows-acl']` 是**唯一一档**（无候选、无 probe），
它从 `workspaceRoot` 派生确定性 SID（`workspace-sid.ts:35`），**不消费
`writableRoots()`**。

→ **本方案在 Windows 上表现为"共享根仍不可写"**：安全的 fail-closed，
但**跨平台行为不一致**。

本部署的 Windows 端点是 **agent 侧**（用户机器），不是 dsh 服务器；
生产服务器是 Linux，走 bwrap。因此本部署**不受影响**，但须**显式声明为已知
边界**，且验收要显式确认"Windows 上不可写是当前预期"，而不是静默半开。

---

## 7. 验收

**先写进验收，再动手。**

### 步 1 · 类型面与 helper（`roots.spec.ts`）

1. `rwRoots` 在 `workspace-write` 下进入 `writableRoots()`
2. `read-only` 下**不**进入（模式闸门）
3. 屏蔽根**外**的共享根**不**出现在 `readShield().allowed`（既有过滤保持）
4. 屏蔽根**内**的共享根**出现**在 `readShield().allowed`
5. 丢弃规则：`'/'`、相对路径、等于 `/tmp`、等于 `tmpdir()`、`workspaceRoot` 的祖先 → 全部丢弃
6. 非 `workspace-write` 模式下 `effectiveRwRoots()` 返回空

### 步 2 · 方言（`sandbox-local` 测试）

7. bwrap profile 含共享根 `--bind`，且**位于 shield 段之后**
8. landlock 的 `readOnly`（有屏蔽时）与 `readWrite` 均含共享根
9. seatbelt profile 未新增 `rwRoots` 相关代码（回归：既有 golden 不变）

### 步 3 · 配置入口（`sandbox-policy` 测试）

10. 不配置时 `resolve()` 返回对象**不含** `rwRoots` 键

### 步 4 · 映射解析与注入（`shell/tests`）

11. `TEAM_SHARED_ROOTS` 缺失 / 非 JSON / 元素形状不对 → 实例照常启动，
    两个 env 均为空数组（**不获得任何额外权限**）
12. `write: false` 的项**不进** `DSH_RW_ROOTS`，**仍进** `DSH_READ_ALLOWED_ROOTS`
13. `operator` 得到两个目录；`member` 只得到 `common`
14. 与 `shadowRoot` 互为祖先的项被丢弃并记日志

### 步 5 · 端到端（**必须在 team-shell profile 下**）

**5.1 角色矩阵**（核心）

| 检查 | winslow / tucker（operator） | 其余 41 人（member） |
|---|---|---|
| 文件工具 `list` `common` | ✓ | ✓ |
| 文件工具 `read`/`write` `common` | ✓ | ✓ |
| 文件工具 `list` `admin` | ✓ | **拒绝** `FS_PERMISSION_DENIED` |
| 文件工具 `read` `admin` | ✓ | **拒绝** |
| 文件工具 `write` `admin` | ✓ | **拒绝** |
| shell `cat common/…` | ✓ | ✓ |
| shell `cat admin/…` | ✓ | **读不到**（`--tmpfs` 擦除） |
| shell 写 `common/…` | ✓ | ✓ |
| shell 写 `admin/…` | ✓ | **失败** |

**5.2 跨入口一致性**（最能暴露漏改）

同一文件：`shell` 写入 **与** 模型文件工具（write/edit）写入，结果必须一致。
**且写前先 `stat`**——只开 G1 不开 G3 会在这里以"能写但 stat 不了"暴露（§2.2）。

**5.3 挂载会话矩阵**（§6.2-②）

| | 本地 session | 挂载 session |
|---|---|---|
| 文件工具写共享根 | 必过 | 必过 |
| 以共享根为 cwd 跑 `touch` | 必过 | 必过（本地分支） |
| 在**影子 cwd** 下 `touch <共享根>/x` | — | **必须失败**，失败方式明确 |

**5.4 屏蔽交互**

共享根与 `readDeniedRoots` 有交集（本方案即如此）时仍**可读且可写**（覆盖风险 ①②）。

**5.5 影子隔离回归**（覆盖风险 ③）

- 以 `/tmp` 或 `/tmp/dsh-shadow` 或其祖先作为共享根 → 被丢弃
- 正常挂载会话下，**其他账号的影子目录仍不可见**（与改造前逐字节一致）

**5.6 向后兼容**

不配置任何共享根时：
- 现有账号的沙箱行为逐字节不变（bwrap / landlock / seatbelt profile 字符串一致）
- `region-router` 行为不变（`readableRoots` 缺省 → 单根边界）

**5.7 符号链接**

`shared/common/link → ../../darcy` 时：沙箱内解析到 tmpfs 的空目录 → 不存在。
指向屏蔽根之外的链接行为须显式记录（§5-⑥）。

**5.8 跨平台声明**

Windows 上显式验证"共享根不可写"是当前预期（§6.4）。

---

## 8. 上线与回滚

**上线**：

**已完成**：1–3（`role` 已改；代码与测试已落地，门禁全绿）。

**待在窗口内执行**：

4. `mkdir -p ~/.dsh-users/shared/{admin,common}`（§3.7）
5. 在 `shell/.env` 设 `TEAM_SHARED_ROOTS`：

   ```sh
   TEAM_SHARED_ROOTS='[{"path":"<usersRoot>/shared/common","roles":["operator","member"],"write":true},{"path":"<usersRoot>/shared/admin","roles":["operator"],"write":true}]'
   ```

6. 重新 provision 目标账号（`spawn-user` 或 `account` 重启路径都会重新写 patch）
7. **重启实例**（沙箱策略在进程启动时读取）

> ⚠️ 重启会中断该主机上所有进行中的会话，排窗口时算进去。

**回滚**：清空 `TEAM_SHARED_ROOTS` → 重新 provision → 重启实例。
映射为空时行为与改造前一致，因此**回滚不需要回滚代码**。

---

## 9. 边界（不做什么）

| 不做 | 理由 |
|---|---|
| 每用户 × 每目录的授权表 | §1.3：需求是按角色，role 已足够 |
| 文件级 / 子目录级授权 | §1.3 |
| 运行期热加载 | §1.3、§5-⑨ |
| 跨机器共享 | §6.2-② |
| Windows ACL | §6.4 |
| 读权限细分（成员不可读某公共目录） | §1.3；角色级可见性已覆盖当前需求 |
| 收敛 landlock `readWrite` 为消费 `writableRoots()` | §3.3：会顺带扩大 `tmpdir()` 写权限，属无关行为变化 |
| 把共享根用于 `read-only` / `danger-full-access` 的写 | §3.4、§6.3 |
