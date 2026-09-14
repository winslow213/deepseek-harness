# Agent Note: The operator-gated plugin install Remote gains an uninstall path

Status: implemented

[English](2026-09-14-plugin-uninstall-remote.md) | 中文

## Problem

[`pluginInstall` Remote](../architecture/2026-09-05-operator-gated-plugin-install-remote.zh.md) 及其 [Web 设置标签页](2026-09-05-web-settings-plugin-install-tab.zh.md) 让运算符能把插件安装进运行中的 profile，但没有任何东西能移除它：一旦 `file-dir`、`upload-directory` 或 `npm-register` 安装写下其 `plugins/<id>` 拷贝与 patch 行，撤销它就意味着手动编辑 `cordis.patch.yml` 并直接在宿主文件系统上删除拷贝目录。装错插件或想退役某插件的运算符没有产品内的退路。

## Decision

**`PluginInstallGateway` 新增第二个 `@Remote('uninstallPlugin')` 方法 `uninstallPlugin(id: string): PluginUninstallResult`。** 它解析与 `installPlugin` 相同的 profile 目录，用相同的路径安全检查校验 id，并移除 `cordis.patch.yml` 中该 id 分隔的行。当该 id 还拥有一个 `plugins/<id>` 目录时——`file-dir` 或 `upload-directory` 安装——该目录也会一并删除；`npm-register` 的 id 没有这样的目录，因此只移除行。当没有行与该 id 匹配时，调用以新增的 `plugin-install/not-installed` RemoteError 失败，因为对这三种形式而言 patch 行就是唯一的安装记录。

**范围刻意只限于三种可 patch 行寻址的形式；`npm-bundle` 被排除在外。** `file-dir`、`upload-directory` 与 `npm-register` 都以写入相同标记分隔行形态的稳定逐插件 `id` 为键，因此一个 `removeMarkedBlock()`（现有 `upsertMarkedBlock()` 的逆操作）加一个 `uninstallPluginById()` 就能覆盖全部三种。`npm-bundle` 完全没有逐插件 id——它通过 `pnpm add` 与 `dsh.profile.bundles` 层列表集成，这是一个由包管理器所有的依赖图，本服务无法安全剥离其中一行而不冒破坏另一 bundle 传递依赖的风险。Remote 的文档注释与设置标签页文案都指引运算符改为在 profile 目录运行 `pnpm remove`。

**`requestRestartIfSupervised()` 原样复用，措辞被泛化。** `installPlugin` 使用的「先落盘，再请求监督者重启实例」机制现在同时服务两条路径；其日志行从安装专属的「install complete」改为「plugin change complete」，因为它不再只描述单一方向。

**设置标签页在同一个 `PluginInstallSettingsTab` 组件内新增第二个独立表单。** 一个只需插件 id 的输入框提交给新注入的 `uninstallPlugin` 面孔，它以与 `installPlugin` 相同的方式把 Remote 失败映射为携带 `code` 的拒绝 `Error`。卸载区域有自己的运行中/成功/重启中/错误状态机，与安装区域的镜像对应，其双语文案也说明了 `npm-bundle` 的排除，因此尝试该操作的运算符会得到可操作的消息，而不是静默无效果。

## Alternatives considered

**通过单独跟踪安装时的 bundle 名称，为 `npm-bundle` 也提供卸载路径。** 拒绝：由 `pnpm` 管理的依赖图可能让同一个包被多条直接/传递边共享，因此在不借助 `pnpm` 自身解析的情况下移除「这次安装加入的 bundle」，有留下孤儿依赖或破坏共享依赖的风险。`pnpm remove` 已经安全地做了这件事；在此重复其逻辑只是维护第二个、更差的依赖移除器。

**通过解析并重新生成 YAML 来重写 `cordis.patch.yml`，而不是拼接标记分隔区域。** 出于与 `installPlugin` 的写入器拒绝同一方案相同的理由被拒绝：patch 文件是带有注释与 `!!js` 表达式的用户编辑层，解析/重新生成的往返不会按字节保留它们。`removeMarkedBlock()` 复用与 `upsertMarkedBlock()` 相同的字符串拼接方式，只触碰该 id 自己的分隔块。

**当 id 没有 patch 行时静默成功。** 拒绝：拼写错误 id 或针对已移除插件的运算符需要知道什么都没发生，而不是收到一个虚假确认。`plugin-install/not-installed` 准确说明问题所在，符合现有失败词汇表「每种原因对应一条可操作消息」的约定。

## Consequences

运算符现在无需离开浏览器即可从设置标签页移除 `file-dir`、`upload-directory` 或 `npm-register` 安装，语义上与安装一样需要重启。`npm-bundle` 安装仍只能手动移除（在 profile 目录运行 `pnpm remove`），这一限制由 Remote 的失败词汇表与标签页文案共同说明，而非静默缺口。宿主包的测试套件新增 8 个用例，覆盖三种受支持形式各自的移除、无关 patch 行的保留、两个失败码，以及受监督重启请求；客户端包的 jsdom 规格新增 4 个用例，覆盖填写前禁用的按钮、成功移除、重启倒计时与 Remote 失败映射。没有会话事件或面向模型的表面发生变化，因此没有快照拥有这条路径。
