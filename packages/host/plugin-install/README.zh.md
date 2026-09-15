---
description: "面向 Web UI 的运算符门控插件安装/卸载 Remote：把外部插件安装/卸载进运行中 dsh profile 的 pluginInstall 服务，含 install Remote（file-dir 拷贝、npm-bundle 与 npm-register 三种形式）与覆盖全部形式的单一 uninstallPlugin Remote。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-plugin-install

[English](README.md) | 中文

## 概述

Web 实例可以通过 Remote 命名空间把外部插件安装进自己的 profile 目录。`pluginInstall/installPlugin` 支持三种形式：`file-dir` 把源目录拷贝到 `plugins/<id>` 下并登记 patch 行；`npm-bundle` 运行 `pnpm add` 并把 bundle 提升进 `dsh.profile.bundles`；`npm-register` 为已安装的 npm 插件补写启动行。`pluginInstall/uninstallPlugin` 通过同一套调和逻辑覆盖全部三种形式：npm-bundle id 运行 `pnpm remove` 并移除 bundles 条目，其余 id（`file-dir`、`upload-directory`、`npm-register`）移除对应 patch 行，对拷贝类安装还会一并删除其 `plugins/<id>` 目录。该服务受运算符门控（`enabled: true`、`DSH_PLUGIN_INSTALL=true`）；client 包通过 [`api-remotes`](../../api/remotes/README.zh.md) 消费它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当运行中 profile 必须获得一个新插件时，从运算符侧客户端调用 `pluginInstall/installPlugin`。Remote 是唯一入口：该服务仅供 Remote 使用，刻意不声明同进程 Cordis `Context` merge。

### 安装形式

请求按 `form` 判别：

- **`file-dir`**——把本地绝对源目录拷贝到 profile 内的 `plugins/<id>`，当拷贝不带清单时补写最小 `{"type": "module"}` 清单，并在 profile 的 `cordis.patch.yml` 插入（或替换）一行由标记包裹的 `- insert:`。插件 id 必须是单个路径安全段（`A-Za-z0-9._-`），因此 id 永远不会逃出 `plugins/` 目录。重装会整体替换先前的拷贝，并原位替换先前的 patch 行。
- **`npm-bundle`**——在 profile 目录运行 `pnpm add <spec>`（目录还没有 profile 清单时先初始化），然后调和 profile 的层栈，把新加入的 bundle 提升进 `dsh.profile.bundles`，使 bundle 层列表反映本次安装。当 pnpm 拒绝某构建脚本（`ERR_PNPM_IGNORED_BUILDS`）时，会把被拒包在 `pnpm-workspace.yaml` 中放行并重试一次；先前拒绝留下的占位条目会被放行并重建，使原生绑定在 profile 重启前就已存在。
- **`npm-register`**——为已安装、但不带 `dsh.bundle`（因此 `npm-bundle` 的调和从未提升它）的 Cordis npm 插件补写启动行：请求携带插件 id 与 Loader 入口解析符（`dsh-some-plugin` 或 `@scope/pkg/lib/index.js`），可选带一个渲染进行内 `config` 键的 JSON 配置对象。该解析符必须能从 profile 的已安装依赖解析，因此拼写错误或未安装的包会在此处以 `plugin-install/unresolved-package` 失败，而不是在下次重启时才暴露。

### 安装进哪个 profile

部署提供了显式 `profileDir` 配置覆盖时，它就是目标 profile；否则服务从引导 `include` 条目的 `config.path`——profile 的 `cordis.yml` 文件 URL——自行定位运行实例的 profile，并取其目录。两者都不存在时调用以 `plugin-install/unknown-profile` 失败。

### 卸载插件

以安装时使用的 id（patch 行 id）或 npm 包名（针对 npm-bundle 安装）调用 `pluginInstall/uninstallPlugin`。该 id 首先与 profile `package.json` 的 dependencies 比对：命中即运行 `pnpm remove <name>` 并调和 profile 的层栈——与 `npm-bundle` 安装提升新依赖走的是同一条调和路径——这也会把被移除的名字从 `dsh.profile.bundles` 中一并去掉。不是真实依赖的 id（`@deepseek-ai/dsh-base` 这类盒内模板 bundle 虽列在 `dsh.profile.bundles` 中，但从不是 dependencies 条目，因此永远不会在此处命中）会回退到 patch 行移除：移除 `cordis.patch.yml` 中该 id 分隔的 patch 行，若该 id 还带有 `plugins/<id>` 目录（`file-dir` 或 `upload-directory` 安装），也一并删除该目录；`npm-register` 的 id 没有这样的目录需要删除。当给定 id 既不是 npm-bundle 依赖也没有匹配的 patch 行时，调用以 `plugin-install/not-installed` 失败。

### 失败词汇表

安装失败抛出带稳定码的 `RemoteError`：`plugin-install/unknown-profile`（无法定位 profile）、`plugin-install/invalid-spec`（id 不安全、源路径不可用或 JSON 配置畸形/非对象）、`plugin-install/unresolved-package`（登记的解析符不是已安装依赖）、`plugin-install/pnpm-missing`（PATH 上没有 pnpm）、`plugin-install/pnpm-failed`（`pnpm add` 或 `pnpm remove` 非零退出）、`plugin-install/write-failed`（拷贝、清单、patch 或调和写入失败）。卸载还会在给定 id 既不是 npm-bundle 依赖也没有匹配 patch 行时另外抛出 `plugin-install/not-installed`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

网关把磁盘上的 profile 作为唯一安装真源：`file-dir` 安装直接写拷贝与 patch 行；`npm-register` 安装直接写启动行；`npm-bundle` 安装把包解析委托给 `pnpm`，让已调和的 profile `node_modules`——它已链接盒内与新增的 bundle——成为解析根。`npm-register` 通过与 Loader 启动时相同的 Node 解析（从 profile 清单 `createRequire`）校验其解析符，从而在重启前就地失败而非把启动错误留到重启后。bundle 簿记由 `dsh-app-boot` 负责：`initProfile` 给缺失的 profile 清单播种，`readProfileManifest` 在安装前快照层状态，`reconcileProfileBundles` 把新加入的 bundle 提升进 profile 层列表。本服务不自做任何 npm 解析。

### Patch 行幂等

Patch 行由 `# >>> dsh-plugin-install <id>` 与 `# <<< dsh-plugin-install <id>` 注释标记包裹。存在匹配标记时，插入会整体替换两块标记之间的内容，因此重装永远不会产生重复行；patch 文件里其余的行、注释与 `!!js` 表达式都按字节原样保留。

### 运算符门控

门控分两层。类构造函数在 `enabled: true` 之外抛错，使错误挂载在加载期响亮失败。独立地，web-app 组合在 `DSH_PLUGIN_INSTALL` 恰为 `true` 之前禁用整行，因此即使包级默认值也不能在默认部署暴露命名空间。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `PluginInstallGateway`：`pluginInstall` Remote 服务、profile 自行定位、各安装形式、卸载路径与 patch 行读写器 |
| [`src/types.ts`](src/types.ts) | 公共 payload 类型：`Config`、`PluginInstallSpec`、`PluginInstallResult` 与 `RemoteErrorDetailsMap` 扩展 |
| — | 不发布运行时不变式伴生入口；安装在 `tests/install.spec.ts` 中针对真实临时 profile 演练。 |

Typert 生成由 `./typert` 与 `./remote` 导出的 Host 和 Client Remote 产物。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当安装约定不够用时阅读以下内容：先看 Remote 如何到达客户端，再看各安装形式所依赖的 profile 与 bundle 机制。

- [Remote 组合](../../api/remotes/README.zh.md)——客户端如何在不导入 Host 实现的情况下消费 `pluginInstall/installPlugin`。
- [App boot](../../boot/app-boot/README.zh.md)——`initProfile`、`readProfileManifest` 与 `reconcileProfileBundles`，安装形式背后的 profile 层簿记。
- [插件安装设计](../../../shell/plugin-install-design.md)——本包所实现的设计文档。

-----

<a id="model-experience"></a>
## 模型体验

无。这个受运算符门控的安装 Remote 不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明运算符门控的安装目前做不到什么。它们是当前包约束，不是任务积压。

- **宿主必须装有 pnpm**——`npm-bundle` 形式调用外部 `pnpm`；未装 pnpm 的宿主以 `plugin-install/pnpm-missing` 失败，安装永不自带包管理器。
- **file-dir 不远程抓取**——`file-dir` 形式只拷贝本地目录；从 registry 或 URL 抓取插件是 `npm-bundle` 的职责。
- **不热重载**——安装只改动磁盘上的 profile 与 patch 层；运行中的 Loader 不会重新读取，效果在下一次 profile 加载时生效。
- **npm-bundle 卸载以 `package.json` 依赖名而非原始安装解析符寻址**——git 托管或别名安装解析符（`pnpm add npm:alias@spec` 或 git URL）解析出的 `dependencies` 键与安装时输入的字符串不同；卸载时请使用安装响应 `bundlesAdded` 中给出的名字或 `dsh.profile.bundles` 中的名字。
- **默认部署永不挂载**——除非运算符显式启用该行并设置 `DSH_PLUGIN_INSTALL=true`，命名空间保持关闭；忘记环境开关的部署得到的是没有安装界面，而不是一个静默半开的命名空间。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
