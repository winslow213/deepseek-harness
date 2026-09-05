---
description: "dsh Web 客户端设置中的操作员门控插件安装标签页：把本地插件目录复制进当前配置目录、安装 npm 包、上传目录或为已安装插件注册启动行，带进度、结果事实与重启指引。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-plugin-install

[English](README.md) | 中文

## 概述

`dsh-client-ui-settings-plugin-install` 向 Web 设置的「插件」分区贡献**安装插件**标签页。标签页提供四种安装方式——把本地插件目录复制进 profile、对 npm 包执行 `pnpm add`、上传所选目录、或为已安装的 npm 插件注册启动行——并把所选方式提交给 `ctx.remote.pluginInstall.installPlugin()`。安装运行期间表单被锁定、提交按钮显示进度；成功后标签页报告写入的配置目录以及安装的插件 id 或被提升的 bundle，失败时显示 Remote 错误消息与错误码。改动只在 Web 实例重启后生效，两种状态下标签页都会说明这一点。只有设置操作员开关 `DSH_PLUGIN_INSTALL=true` 时标签页才注册，与宿主侧安装 Remote 一致。

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

打开设置中的「插件」分区并选择**安装插件**标签页。插件激活期间不会读取 Remote——只有提交表单时才调用 `ctx.remote.pluginInstall.installPlugin()`。

### 选择安装方式

**复制本地目录**方式需要插件 id 与含 `index.ts` 入口的目录的绝对路径；它把目录复制到 profile 的 `plugins/<id>`/ 下并注册启动行。**安装 npm 包**方式需要一个原样转发给 `pnpm add` 的包标识；声明 `dsh.bundle` 的包会被纳入 profile 的 bundle 列表。**注册已安装的 npm 插件**方式需要插件 id、一个能从 profile 已安装依赖解析的 Loader 入口解析符，以及可选、写入启动行 `config` 键的 JSON 配置对象。每种方式都先填满必填字段才能启用提交按钮，并会去除提交值的首尾空白。

### 阅读结果

安装成功后报告插件写入的配置目录、目录复制对应的插件 id 或 npm 安装对应的被提升 bundles，随后是重启提示。被拒绝的安装报告 Remote 错误消息及其错误码。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

标签页只是宿主所有 `pluginInstall` Remote 之上的浏览器端表单；全部视图状态留在本地，从不读取 Loader。

### 注册

浏览器插件注册一个本地化的 `settings.plugins.tab` 贡献，id 为 `plugin-install`、`order: 20`，紧挨只读的插件清单标签页。注册使用 `ctx.slots.inject()`，因此跟随标签页的迟到声明、重新声明、locale 变化与拆卸，而不需要导入分区所有者。

### Remote 失败映射

注入的 `installPlugin` 面孔把被拒绝的 Remote 结果（`{ ok: false, error: { code, message } }`）映射为携带 code 的拒绝 `Error`；组件原样渲染消息与 code，传输与拒绝细节不会漏进文案。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面覆盖设置分区、远程调用与宿主侧服务。

- [ui-settings-plugins](../ui-settings-plugins/README.zh.md) — 本标签页注册进的「插件」分区。
- [ui-settings-plugin-inventory](../ui-settings-plugin-inventory/README.zh.md) — 与它并列的只读「插件列表」标签页。
- [ui-settings](../ui-settings/README.zh.md) — 声明 `settings.plugins.tab` 的领域基座。
- [api-remotes](../../api/remotes/README.zh.md) — `pluginInstall.installPlugin()` 背后的 Remote BFF 表面。
- [plugin-install](../../host/plugin-install/README.zh.md) — 本标签页驱动的宿主侧安装服务。

-----

<a id="model-experience"></a>
## 模型体验

无，浏览器端标签页只渲染安装表单并提交给 `pluginInstall` Remote，不注册任何面向模型的东西。

#### KV 缓存影响

无；本包既不组装也不发送任何 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了安装流程的新鲜度与重启耦合；它们是当前包约束。

- **只在重启后生效** — 安装成功报告的是写入已落盘，而不是插件已生效；运行中的 Web 实例只在重启后激活新 bundle。
- **重启后不自动刷新** — 标签页不监视进程也不轮询清单；操作员重启实例后需要手动刷新页面。
- **仅限自身目标** — 标签页只安装进运行中实例自己的配置目录；选择其他已注册用户的实例是刻意的后续工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

无。

</details>

**运行时不变式：** 不发布不变式伴生包，因为本包没有可分歧的运行时观测；它只在宿主安装 Remote 之上渲染表单。
