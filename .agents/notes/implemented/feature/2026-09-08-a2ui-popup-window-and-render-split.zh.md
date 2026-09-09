# Agent Note: A2UI 弹窗窗口与零 cordis 渲染拆分

Status: implemented

[English](2026-09-08-a2ui-popup-window-and-render-split.md) | 中文

## Problem

模型生成的 A2UI 页面以会话节点（Conversation Node）的形式内联渲染在聊天转录里。内联渲染把页面绑死在聊天栏里：表单或画布只能挤在狭窄的消息宽度内，无法在用户滚动或切换会话时保持打开，也没有一块专门的可复用界面。此外，内联渲染器原本放在 `ui-a2ui` 插件内部，而 web 前端的静态装配（它负责构建专用弹窗入口 `/a2ui.html`）一旦打包它，就会把该插件所拥有的客户端 Context 合并一并拖进来。

## Decision

A2UI 页面改在专用弹窗窗口中渲染，同时把渲染器拆到一个零 cordis 的包里，使插件与静态装配都能消费它。

- **弹窗窗口化。** `A2uiLauncher` 取代内联面板：一张紧凑卡片，其按钮调用 `window.open('/a2ui.html', 'a2ui-<surfaceId>', …)`。弹窗与打开方共享一套带类型的 postMessage 词汇（`a2ui/ready` → 携带 `surfaceId` 与 `page` 的 `a2ui/init`；`a2ui/submit` 与 `a2ui/action` 回传给打开方），launcher 把提交与模型动作转发进一条已记录的上下文 notice（见[提交 notice 记录](2026-09-09-a2ui-submission-notice-context.zh.md)），正如原先内联面板把它们转发进输入机。
- **零 cordis 渲染拆分。** 新的 `staticLinked` 包 `dsh-client-ui-a2ui-render` 拥有表单/画布渲染器、表达式求值器与独立弹窗挂载。`apps/web` 引入它来构建 `/a2ui.html`；`ui-a2ui` 只类型引用其 wire 类型，因此静态装配永远不会拉入插件的客户端 Context 合并。
- **在点击手势内开窗。** `A2uiStorePanel` 直接在自己的点击处理器里打开具名弹窗窗口，因此没有任何 launcher 的 `window.open` 运行过以捕获引用。弹窗用从自身窗口名读到的 `surfaceId` 宣告 `a2ui/ready`，重渲染投射出的 launcher 通过匹配宣告中的 `surfaceId` 并取 `event.source` 作为其追踪窗口来「收养」该弹窗，从而在避免浏览器拦截弹窗的同时完成握手。
- **静态主题样式。** 弹窗没有 `ui-theme` 插件在运行时注入设计令牌样式表，因此弹窗入口静态引入 `base.css` / `design-platform.css` / `corner-shape.css` / `scrollbar.css`；渲染组件读取的 `--dsw-alias-*` 与 `--dsw-font-*` 变量从这些样式表中解析。
- **`a2uiStore/remove` 改名为 `a2uiStore/delete`。** `remove` 与 Cordis Remote 命名空间服务的保留成员冲突，会导致整个 `api-remotes` 插件加载中止；客户端 Remote 方法及其 wire 请求/值类型现改用 `delete`。

## Alternatives considered

**保留内联渲染。** 否决：页面需要能在自己的窗口中可用、并能从侧边栏复用，这是聊天栏无法提供的。

**在弹窗内运行 `ui-theme` 插件。** 否决：弹窗是最小表面，没有会话、模块表或主机连接；为注入 CSS 而拖入完整插件生命周期会破坏其轻量性，静态 CSS 引入才是完整答案。

**弹窗只发送一次 `a2ui/ready`。** 否决：侧边栏可能在聊天 launcher 挂载消息监听器之前就打开窗口，单独一次 `ready` 会被丢弃、握手卡死。弹窗改为周期性重发，直到收到 `a2ui/init`。

## Consequences

弹窗是独立文档，因此渲染组件读取的任何新增 `--dsw-*` 变量都必须能从静态引入的主题样式表中解析，否则弹窗会静默降级。弹窗拦截只能通过「在用户手势内开窗」来规避；launcher 按钮及其「直接打开」链接仍是兜底。渲染包是零 cordis 的：它绝不能引入客户端 Context 合并，否则静态装配边界会被打破。
