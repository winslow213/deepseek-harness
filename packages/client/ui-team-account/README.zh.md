---
description: "Web 设置-通用里的 team-shell 行：「退出登录」向 /api/logout 发请求，「生成配对码」通过 /api/pairings 签发多设备配对码；两者都仅在 team-shell 标记存在时渲染。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-team-account

[English](README.md) | 中文

## 概述

本包在 Web 设置-通用 中新增两行：**生成配对码** 与 **退出登录**。两者都仅在服务文档带有 team 反向代理注入的 `<meta name="team-shell">` 标记时才出现，因此普通单用户 dsh 部署保持不变。

**退出登录** 行向同源 `/api/logout` 发 POST —— 代理以同时清除团队会话与 dsh 实例 cookie 作为应答 —— 然后跳转到 `/`，此时未认证入口提供登录页。**生成配对码** 行向同源 `/api/pairings` 发 POST（经代理转给账号服务、会话鉴权），随后展示签发的配对码、在每台设备上运行的认领命令与复制控件；该码在 TTL 内可复用，因此一个码可挂载多台设备。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在浏览器组合中与 settings 包一起挂载本插件；当文档由 team shell 服务时，「生成配对码」行会出现在通用设置中（位于「退出登录」之前）。在任何其他部署中两行都不出现。

### 退出登录行

整格即为点击目标：左侧为本地化标题与提示，右侧为箭头。点击时向 `/api/logout` 发送 POST（含凭据、同源），收到响应后跳转 `/`。即使请求失败仍会跳转，让入口重新认证成员，而不是把成员留在一个会话已失效的页面上。

### 生成配对码行

点击该行会向 `/api/pairings` 发送 POST，并展开一个内联面板，展示签发的配对码、有效期、认领命令（`dsh-shell remote agent --pair <uuid> --hub <host>:7101 --root <dir> [--allow-command ...]`），以及针对两者的复制控件。配对码不会进入会话日志，agent token 也绝不会到达浏览器——账号服务把它留在服务端。

### 出现时机

team 反向代理为每个服务的 HTML 文档注入 `<meta name="team-shell" content="1">`。仅当文档 head 存在该标记时两行渲染。缺少标记时插件不贡献任何可见内容——单用户 dsh 与非代理部署从不显示这些行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>Implementation internals — click to expand</summary>

浏览器插件在 `settings.general.item` 槽注册两个条目：`team-pairing`（order `90`）与 `team-account`（order `100`，位于其后）。退出登录行是一个无状态按钮，其点击处理器向同源 `/api/logout` 发 POST，然后赋值 `window.location.href`。配对行只拥有本地状态（idle/busy/ready/error）：它向 `/api/pairings` 发 POST，解析 `{uuid, expiresAt}`，并根据 `window.location.hostname` 构建认领命令；复制控件使用共享的 `writeClipboard` 原语。渲染门在文档 head 中同步读取 team-shell meta 标记；槽条目始终注册（HMR 与 locale 重新注册持续可用），只有可见渲染被门控。文案位于 `settings.teamAccount` locale 命名空间，含完整 zh/en 字典；行文案键走标准槽 locale seat。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当退出与配对面不足时阅读这些页面。它们从浏览器行延伸到入口与实例会话。

- [Team access design](../../../shell/team-access-design.md) — 团队账号服务、登录路由、`/api/logout` 双重清除契约，以及配对码签发/认领链路。
- [reverse-proxy.ts](../../../shell/src/reverse-proxy.ts) — 注入 team-shell 标记、应答 `/api/logout` 并把 `/api/pairings` 转发给账号服务的 account 模式代理。
- [Client package map](../README.zh.md) — 相邻浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

None, as the package is a browser-side settings surface that registers nothing model-facing.

#### KV 缓存影响

None; this package neither assembles nor sends a provider request.

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定了当前退出与配对面。它们是当前包的约束，而非任务积压。

- **Requires the team-shell marker** — 这些行仅在 team 反向代理服务的文档中渲染；其他部署从不显示。
- **Web-only** — 非 Web 客户端没有等效的浏览器贡献。
- **配对码展示是瞬态的** — 签发的码只在当前渲染中展示；刷新页面即丢失（重新签发，或先复制）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
