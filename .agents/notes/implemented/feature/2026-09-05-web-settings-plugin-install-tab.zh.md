# Agent Note: The Web Settings Plugins section gains an operator-gated install tab

Status: implemented

[English](2026-09-05-web-settings-plugin-install-tab.md) | 中文

## 问题

Web GUI 能读插件清单却不能安装：Phase A 给运行实例加上了操作员门控的 [`pluginInstall` Remote](../architecture/2026-09-05-operator-gated-plugin-install-remote.zh.md)，但 Web 平面没有任何调用它的东西，GUI 操作员仍要离开应用去打开终端。设计文档的 Phase 4——Web UI 标签页——正是缺失的消费端，让浏览器里的操作员能够触达该 Remote。

## 决定

**新浏览器包 `@deepseek-ai/dsh-client-ui-settings-plugin-install` 向 Web 设置的「插件」分区贡献「安装插件」标签页。** 标签页提供两种安装方式——复制本地插件目录（插件 id 加源码目录绝对路径）与安装 npm 包（一个原样转发给 `pnpm add` 的包标识）——并把所选方式提交给 `ctx.remote.pluginInstall.installPlugin()`。它被接进 web-app bundle 的浏览器花名册，紧挨只读的插件清单标签页，且无条件挂载；插件自身的 `inject: [..., 'remote.pluginInstall']` 会让它一直处于待定状态，直到该 Remote 存在为止，因此只有在宿主行的 `DSH_PLUGIN_INSTALL=true` 开关挂载了该 Remote 之后它才会真正生效，而浏览器花名册行本身不必携带 `!!js` 表达式（`bundle-roster.ts` 要求浏览器层的 `disabled` 保持纯布尔值）。

**注册是一个本地化的 `settings.plugins.tab` 贡献。** 插件注入 `slots`、`locale`、`remote` 与 `remote.pluginInstall`，并通过 `ctx.slots.inject()` 注册 id 为 `plugin-install`、`order: 20` 的条目，因此跟随「插件」分区的迟到标签页声明、重新声明、locale 变化与拆卸，而无需导入分区所有者。字典命名空间 `settings.pluginInstall` 是中英双语，条目标签经共享 locale thunk 解析。

**表单完整持有自己的生命周期。** 提交会去除规格值的首尾空白、在安装运行期间锁定表单与提交按钮，然后渲染结果事实——写入的配置目录、安装的插件 id 或被提升的 bundles、以及重启提示——或在被拒绝时原样渲染 Remote 错误消息与错误码。注入的 `installPlugin` 面孔把 `{ ok: false, error: { code, message } }` 映射为携带 code 的拒绝 `Error`，组件永远看不到传输或拒绝内部细节。

## 备选方案

- **用 `!!js` 表达式门控浏览器花名册行。** 已拒绝：`packages/test-support/client-runtime/src/assembly/bundle-roster.ts` 会在浏览器层某行的 `disabled` 不是纯布尔值或未设置时抛出异常，因为花名册在 Loader 自身的插值之外单独组装。对 `remote.pluginInstall` 的 `inject` 等待复现了同样的「默认关闭」行为——宿主 Remote 未挂载时标签页永不生效——而不违反这一约束。
- **无条件挂载标签页，只由 Remote 门控决定。** 就「渲染出一个永远失败的表单」这层意思而言已拒绝：默认部署绝不能注册标签页的 UI。修复保留了这一保证——`inject` 让插件停留在待定状态，而非已生效——同时移除了花名册层的 `!!js` 表达式。
- **把安装方式并进插件清单标签页。** 已拒绝：清单标签页是没有变更路径的只读投影；安装带有自己的状态机（idle/running/success/failure）与自己的 Remote，独立贡献让只读标签页不沾染写入面。
- **把拒绝交给通用错误通道。** 已拒绝：Remote 错误已经可操作（`pnpm-missing`、`invalid-spec`、`write-failed`）；在标签页里原样渲染消息与 code，让文案保持 locale 所有、失败可直接处置。

## 后果

web-app bundle 增加一条操作员门控的客户端行与一个依赖，`tsconfig.client.json` 引用新包。默认部署不受影响：没有 `DSH_PLUGIN_INSTALL=true` 时，标签页对 `remote.pluginInstall` 的 `inject` 等待永远不会解除，即使其花名册行是无条件挂载的，它也不会生效。开关打开时，操作员可以从设置里把源码目录或 npm bundle 安装进运行中的 profile，并看到持久化的结果事实或可操作的拒绝信息。本包不注册任何面向模型的东西，也不注册任何会话事件，因此没有快照持有它的输出。两个 spec 文件钉住行为：jsdom 组件 spec 用脚本化的 install 面孔覆盖提交去空白、运行态锁定、成功事实与错误渲染；浏览器插件 spec 对注册、locale 跟随标签与 Remote 失败映射做 bench。同一组件后续新增一个[卸载区域](../feature/2026-09-14-plugin-uninstall-remote.zh.md)，用于移除先前安装的插件。
