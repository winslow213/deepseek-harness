# Agent Note：WebUI 通过操作者门控的 Remote 把插件安装进自己的 profile

状态：已实现

[English](2026-09-05-operator-gated-plugin-install-remote.md) | 中文

## 问题

[`dsh plugin install`](../../../../apps/cli/src/plugin.ts) 只能在终端里安装插件：它把源码目录复制进 profile，或运行 `pnpm add`，然后写入运行中实例要加载的持久化 profile 文件。Web GUI 通过只读的 [`pluginInventory` 投影](2026-08-29-plugin-inventory-agent-preset-scopes.zh.md) 读同一个 profile，但 web 平面没有任何安装入口——GUI 操作者想装插件只能退出应用去开终端。补上这个缺口意味着在运行实例上暴露一个安装调用，而这个调用写的就是实例自己组合的 profile：复制目录、编辑 `cordis.patch.yml`、运行 `pnpm add`、重写 `dsh.profile.bundles`。一个有这种能力的命名空间绝不能默认可达，而且它的失败必须说清操作者能修什么。

## 决定

**新宿主包 `@deepseek-ai/dsh-host-plugin-install` 在 `pluginInstall` 命名空间上暴露一个 Remote 方法。** `PluginInstallGateway extends TypertRemoteService`，注入 `loader`，通过 `('installPlugin')` 回答 `installPlugin(spec)`——这是 GUI 标签页在 Phase 4 要注册的[远程方法表面](../../../../packages/api/remotes/README.zh.md)。命名空间挂进 web-app 组合，并经 api remotes 的 `$mount` 列表到达客户端，与 `pluginInventory` 的传输方式一致。它不注册任何模型侧内容：安装调用是操作者触发的 profile 变更，不是 agent 循环调用的能力。

**操作者门控在组合行上，服务自己再核验一次。** web-app 的 `cordis.patch.yml` 行仅在 `DSH_PLUGIN_INSTALL=true` 时挂载该包——一个 `disabled: !!js` 表达式，由 [Loader 自己的 disabled 插值](2026-08-11-loader-entry-disabled-interpolation.zh.md) 求值，因此默认部署根本不会加载这段代码。服务构造器在 `enabled` 配置为 false 时独立抛错，所以没有开关就挂载该包的嵌入方会在加载时大声失败，而不是默默提供命名空间。两层是因为它们门的对象不同：组合决定包里有没有这个包；构造器断言部署确实想暴露它。

**目标 profile 是运行实例自己的 profile，用两种方式定位。** 显式 `profileDir` 配置覆盖优先，供测试和面向外部目录的嵌入方使用。否则服务自定位：bootstrap 的 `mountRootInclude` 固定一个 `id: 'include'` 的 loader 条目，其 `config.path` 是 profile 的 `cordis.yml` 文件 URL，profile 目录就是该 URL 的父目录。两者皆无的部署得到一个 `plugin-install/unknown-profile` RemoteError，绝不静默回退。

**`file-dir` 把源码目录复制进 profile 并登记它的 patch 行。** 源码被校验为绝对存在的路径，插件 id 被校验为单个路径安全片段（字母、数字、`.`、`_`、`-`），因此 id 永远逃不出 `plugins/`。目录落到 `profileDir/plugins/<id>/`，整体替换先前的副本；当副本没有 `package.json` 时写入 `{ "type": "module" }` 松散插件清单——一个无名的标记，把复制的目录与 profile 自己的 bundle 清单隔开。命名 `file://<profileDir>/plugins/<id>/index.ts` 的 `- insert:` 行插入 `cordis.patch.yml`，位于 `# >>> dsh-plugin-install <id>` 与 `# <<< dsh-plugin-install <id>` 标记注释之间；重装恰好替换这个块，所以文件里其它所有用户行、注释和 `!!js` 表达式都逐字节保留。

**`npm-bundle` 在 profile 目录里运行 `pnpm add` 并调和层栈。** 没有 `package.json` 的 profile 先用 `initProfile` 初始化；包 spec 被校验为非空，并以 profile 为 cwd 转发给 `spawnSync('pnpm', ['add', spec])`（Windows 上带 shell shim，与 CLI 一致）。找不到 pnpm 报 `plugin-install/pnpm-missing`；非零退出报 `plugin-install/pnpm-failed` 并带退出码。成功后把安装前的 profile 清单交给[共享的 `reconcileProfileBundles`](2026-08-05-profile-plugin-bundles.zh.md)——以 profile 自己的 `package.json` 作为安装锚点——把 `dsh.bundle` 包提升进 `dsh.profile.bundles`；提升的包名以 `bundlesAdded` 出现在结果里。

**每个失败都是带可操作消息的 `RemoteError`。** `src/types.ts` 中的 `RemoteErrorDetailsMap` 扩展拥有这个封闭集合：`unknown-profile`、`invalid-spec`、`pnpm-missing`、`pnpm-failed`、`write-failed`。写入失败会包裹原因并说出是哪个 id、哪个 profile 目录失败，GUI 表面可以直接原样渲染这条消息。

## 考虑过的替代方案

**复用 CLI 的安装代码而不是新建包。** 否决。CLI 是 `apps/` 入口，它的安装路径把 pnpm 转发、警告流和错误样式与命令解析混在一起；宿主服务需要同一套持久化写入，但要放在 Remote 契约后面，Phase A 让 CLI 继续当已发布权威，而服务复用共享的 boot 件（`initProfile`、`reconcileProfileBundles`、`PROFILE_PATCH_FILENAME`）——正是提交 `11a30687a5` 提取出来让两个调用方都保持诚实的那部分。

**只在组合层门控，或只在构造器里门控。** 单独一层都有洞：只组合层让嵌入方可以在无保护下挂载包；只构造器仍然在每次默认部署里加载并解析命名空间。两层一起让默认部署可证明不含这段代码，任何显式挂载可证明是有意的。

**从配置值推断 profile 并静默回退。** `mountRootInclude` 的 include 条目正是运行实例已记录的 profile 位置；`resolveProfileDir()` 里藏一个 `?? default` 会悄悄装进实例并未组合的目录。显式 `profileDir` 覆盖只给知道目标的调用方；其它所有人都必须经组合的 include 条目解析，否则大声失败。

**重新 dump YAML 文件来打补丁。** 否决。`cordis.patch.yml` 是用户编辑的 patch 层，装着任意注释和 `!!js` 表达式；解析再重发会重写这些字节。标记分隔的字符串拼接只触碰服务自己的块，这是服务能声称的唯一定等性。

**按 CLI 行为校验安装表面。** 推迟给 CLI 自己的 e2e 覆盖。服务测试钉住持久化输出（复制的目录树、清单、patch 块、bundle 提升）和错误词汇；CLI 保留它自己的安装 e2e，直到 GUI 标签页（Phase 4）成为值得共享契约的第二个消费者。

## 后果

web-app 组合包获得操作者门控的安装行并新增对新包的依赖，api remotes 客户端 `$mount` 该命名空间，config 与 module-graph 目录列出新行。默认部署不会组合其中任何东西：`DSH_PLUGIN_INSTALL` 未设置时组合阶段就禁用该行，包从不加载。操作者启用后，GUI 可以用 CLI 产生的同一套持久化写入把源码目录和 npm bundle 都装进运行中的 profile，每次拒绝都点出问题所在（缺 `pnpm`、非路径安全 id、没有组合 include 条目）。服务没有任何模型侧表面，也不注册会话事件，所以没有快照拥有它的输出；15 个用例的 spec 用真实 Loader 组合驱动临时 profile 夹具，pnpm 路径用 `spawnSync` 模拟。调用这个命名空间的 GUI 设置标签页是设计文档的 Phase 4，刻意不在本次变更里。
