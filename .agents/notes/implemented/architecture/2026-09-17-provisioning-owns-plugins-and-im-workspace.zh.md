# Agent Note: Provisioning owns the mandatory plugin set and the IM workspace default

Status: implemented

[English](2026-09-17-provisioning-owns-plugins-and-im-workspace.md) | 中文

## Problem

每个 team-shell 账户都需要的两样东西，以不同方式被留给了成员自己去办。

**必需插件集。** `@xmanrui/dsh-im` 与 `@nanmicoder/dsh-agent-teams` 是账户能从 IM 触达、并能运行团队工作流的前提。操作者可以逐账户手工安装，成员也可以通过常规插件流程添加，但没有任何机制让新账户一创建就带上它们，或让既有账户在该集合变化后跟上。缺了它们的账户不是降级，而是隐形：没有机器人，没有工作流。

**IM 工作区默认值。** `@xmanrui/dsh-im` 把每个通道的默认工作区解析为 `resolve(config.workspace ?? process.cwd())`，而每个 team-shell 实例都以共享仓库根作为 `cwd` 启动。因此，一个尚未记录映射的机器人，在首次连接时就宣称整个仓库是它的工作区。这在不同账户上从飞书被报告了不止一次，而每次的纠正都是手改某一个账户的 `workspaces.json`——修好了操作者面前的那个账户，下一个则一模一样地出错。

## Decision

**`provisionUserHome` 通过与成员相同的路径安装钉住的插件集，并把 IM 工作区默认值同时写进配置和数据。**

`ensureMandatoryBundles` 通过调用 `dsh plugin --profile web add` 针对账户 home 安装 `MANDATORY_BUNDLE_SPECS` 中的每个 spec，而不是直接编辑 profile 清单。于是这次安装产出的 `dependencies` 条目与 `dsh.profile.bundles` 行，与成员自己选择安装的无法区分；并且如果插件流程的记账方式将来变化，它依然正确。当所有钉住的 spec 都已匹配时，它完全跳过安装——这在首次之后的每次重启中都是常态；安装失败时它记录日志并留给下一次重启重试，而不是让成员的登录卡在一次 registry 抖动上。

**`ensureImWorkspaceDefault` 重写指向共享仓库根的既有映射，`ensureImWorkspacePatch` 阻止新的错误映射被记录下来。**

两者并不冗余。数据重写修复在配置存在之前就记录了错误路径的机器人；配置决定机器人从现在起记录什么，因此会话中途注册的机器人立刻拿到正确默认值，无需改写文件、无需重启。`ensureImWorkspacePatch` 向账户 home 级 `cordis.patch.yml` 中插入一段 shell 自有块，为运行时会读取 `config.workspace ?? process.cwd()` 的全部十一个 `@xmanrui/dsh-im` 通道设置 `workspace`——`feishu`、`weixin`、`dingtalk`、`wecom`、`wecomApp`（与它的同级不同，是驼峰式）、`qq`、`slack`、`telegram`、`discord`、`whatsapp`、`imessage`；后三个继承共享控制器的行为而非自行读取。它只在插件确实已安装时写入，因为一个指名不存在行的按 id 补丁是硬启动失败。

两者都在每次 `provisionUserHome` 调用时运行，因此既有账户在下次重启时自愈，新账户从创建起就是正确的。

## Alternatives considered

**直接编辑 profile 的 `package.json` 与 bundles 列表。** 被否决：它会产出只是*看起来*像已安装插件的记账。走 `dsh plugin add` 意味着协调器自己对已安装状态的视图仍是权威，于是将来插件记录方式的变更不会与供给写入的内容静默分叉。

**把工作区写进 profile 级 `cordis.patch.yml`。** 被否决，理由与[wiki 的注入](../feature/2026-09-16-team-shell-user-wiki.zh.md)选择 home 级文件相同：profile 级补丁在每次供给调用时都被 `injectRegionRouter` 整体覆写，因此写在那里的块会在下一次刷新时被抹掉。home 级补丁已有既定的 upsert 约定。

**只修既有账户的已记录映射，做一次性清扫。** 被否决，因为已经试过了：它修好了操作者面前的账户，下一个机器人照样记录同一个错误路径。在配置层纠正默认值，才是让修复对一个尚不存在的机器人也成立的做法。

**只修配置。** 被否决：在配置存在之前就记录了仓库根的机器人会保留那个映射，而运行时读的是 `workspaces.json`。

**在 spawn 时用环境变量设置工作区。** 被否决：插件的优先级是 `config.workspace` 高于 `process.cwd()`，所以环境变量层面的答案用错了杠杆——何况成员自己的覆盖值本来也只能从通道配置里读。

## Consequences

新账户现在一创建就已装好团队的插件集，且每个 IM 通道都被钉到自己的工作区；既有账户在下次重启时收敛。本部署中，变更之后的清扫未再发现错误映射，且配置块被验证为合并而非替换它所针对的那一行（`--dump-config` 显示 bundle 的 `name` 与新增的 `config` 并存）。

代价是账户首次供给时的一次 `pnpm add`（此后跳过），以及一个依赖包仓库可达的供给步骤——这正是安装失败被记录并延后而非致命的原因。配置列表是十一个手写的通道名，因此插件日后新增的通道在这份列表被扩展前不会被覆盖；替代方案是在运行时枚举该插件的通道，而插件并未暴露这一点。

测试覆盖为 `shell/tests/spawn-user-mandatory-bundles.spec.ts`（已是最新时的跳过路径，以及安装失败不抛异常）与 `shell/tests/spawn-user-im-workspace.spec.ts`（已记录映射的重写、十一通道补丁、插件缺失时的保护、以及幂等性）。
