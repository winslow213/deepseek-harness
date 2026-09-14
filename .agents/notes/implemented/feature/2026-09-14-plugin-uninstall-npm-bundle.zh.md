# Agent Note: 插件卸载扩展至覆盖 npm-bundle 依赖

Status: implemented

[English](2026-09-14-plugin-uninstall-npm-bundle.md) | 中文

## Problem

[卸载 Remote](2026-09-14-plugin-uninstall-remote.zh.md) 刻意排除了 `npm-bundle` 安装，理由是该形式没有逐插件 id 可供移除定位。实际情况是，通过 `npm-bundle` 安装插件的运算符——Web UI「安装 npm 包」输入框实际使用的正是这一形式——每次尝试卸载都会命中 `plugin-install/not-installed`，且没有产品内路径可移除它；被排除范围的那份笔记自己的文案让他们改为在宿主上手动运行 `pnpm remove`，而大多数运算符从 Web UI 的部署形态里根本做不到这一点。

## Decision

**`uninstallPlugin(id)` 在回退到 patch 行路径之前，先尝试 npm-bundle 移除。** 新增的 `isNpmBundleDependency(profileDir, packageName)` 检查 `packageName` 是否精确命中 profile `package.json` `dependencies` 中的某个键——通过安装路径已在使用的同一个 `readProfileManifest()` 读取。命中即路由到 `uninstallNpmBundle()`，它镜像 `installNpmBundle()` 自身的模式：先给 `before` 清单拍快照，运行 `pnpm remove <packageName>`，再调用安装路径同样调用的 `reconcileProfileBundles()`，并传入 `before` 让它与移除后的清单做差异比对。`reconcileProfileBundles()` 早已把「消失的依赖」当作已移除并从 `dsh.profile.bundles` 中剥离——这条移除检测逻辑原本是为「后续更新去掉了 `dsh.bundle` 声明」而建的，覆盖「包已被整体移除」这种情况无需任何改动。

**依赖检查在 `assertPluginId()` 之前运行，而非之后。** `PLUGIN_ID_PATTERN` 拒绝 `/` 与 `@`，所以带作用域的 npm 包名（`@scope/pkg`）永远无法抵达 patch 行路径。先做 npm-bundle 成员检查——一次无副作用的字符串比较——能让带作用域或不带作用域的 bundle 依赖在从未触碰路径安全拒绝逻辑的情况下被移除；而没有命中任何依赖的 id（包括此前测试用的 `../escape`）则原样落入 `assertPluginId()`，抛出与之前相同的 `plugin-install/invalid-spec`。

**盒内模板 bundle 靠「从不是真实依赖」而非白名单来保护。** `@deepseek-ai/dsh-base` 及其同类在 profile 初始化时被列入 `dsh.profile.bundles`，但从未被写作 `package.json` 依赖，因此 `isNpmBundleDependency()` 永远不会命中它们，它们会落入 patch 行路径，那里没有它们的行，最终以 `plugin-install/not-installed` 结束——与本次改动之前完全相同的结果，只是走的是同一条既有路径。

## Alternatives considered

**保留前一份笔记对「单独跟踪安装时 bundle 名称」的拒绝。** 依然成立：本次改动没有新增任何「npm-bundle 安装过哪些名字」的簿记。它复用 profile 清单本身作为「当前是哪些依赖」的唯一真源，与安装路径的做法完全一致，因此并未推翻此前对并行跟踪器的拒绝——被推翻的只是「没有跟踪器就无法移除 npm-bundle」这一结论。

**要求 Remote 携带一个独立的 `form` 参数，而非仅从 `id` 推断移除路径。** 拒绝：其余每种 id 移除都无需 form 提示——id 空间（patch 行 id 是路径安全的，npm-bundle 名字是 `package.json` 依赖键）互不重叠，因此单一字符串参数依然无歧义，client 的卸载表单也无需新增输入项。

## Consequences

运算符现在可以从同一个设置标签页区域卸载任何通过 Web UI 安装的插件，包括 npm-bundle，无需离开浏览器或触碰宿主文件系统。宿主包的测试套件新增 4 个用例，覆盖 npm-bundle 移除、盒内 bundle 名称不命中、`pnpm remove` 失败以及该路径上的受监督重启请求。Remote 与两个包的 README、以及设置标签页的卸载文案，都已去掉本笔记前身记录的「npm-bundle 不在覆盖范围内」措辞——排除范围曾经存在的原因与本次变化，见[被本笔记推翻的排除范围决策](2026-09-14-plugin-uninstall-remote.zh.md)。
