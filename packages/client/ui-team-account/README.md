---
description: "General-settings rows for team-shell deployments: a Sign out row that posts to /api/logout, a Pairing code row that mints a multi-device pairing code through /api/pairings, a Keep-instance-running row, and a Message Center row that opens the account service's /inbox page; all render only under the team-shell marker."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-team-account

English | [中文](README.zh.md)

## Summary

This package adds rows to Web Settings General: **Pairing code** (生成配对码), **Keep instance running** (保持实例常驻), **Message Center** (消息中心), and **Sign out** (退出登录). All appear only when the served document carries the `<meta name="team-shell">` marker the team reverse proxy injects, so a plain single-user dsh deployment stays unchanged.

**Sign out** posts to same-origin `/api/logout`, clearing the team session and dsh instance cookie, then navigates to `/` for the unauthenticated login page. **Pairing code** posts to same-origin `/api/pairings` (proxied to the account service, session-authenticated) and shows the minted code, claim command, and a copy control; the code is multi-use within its TTL, so one code mounts several devices. **Keep instance running** toggles the signed-in member's idle-reclaim exemption through `/api/me/idle-exempt`. **Message Center** opens the account service's `/inbox` page in a new tab, where members exchange messages and tasks.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin in the browser composition beside the settings packages; the rows then appear in General settings when the document was served by the team shell, in this order: Pairing code, Keep instance running, Message Center, Sign out. In any other deployment none of them appears.

### The Sign out row

The whole cell is the tap target: a localized title and hint on the left, a chevron on the right. A click posts `POST /api/logout` (credentials included, same origin) and navigates to `/` on response. A failed request still navigates, so the entry re-authenticates the member rather than leaving them on a page whose session is already gone.

### The Pairing code row

Clicking the row posts `POST /api/pairings` and expands an inline panel with the minted code, its expiry, the claim command (`dsh-shell remote agent --pair <uuid> --hub <host>:7101 --root <dir> [--allow-command ...]`), and copy controls for both. The code never appears in a session log and the agent token never reaches the browser — the account service keeps it server-side.

### The Message Center row

Clicking the row opens the account service's `/inbox` page in a new tab, so the conversation the member is currently in stays intact. That page is one self-contained document the account service serves: a contact sidebar ordered by recent activity, a thread pane, and a composer, driven by polling against `/api/messages` with every dynamic value inserted through `textContent`.

### When they appear

The team reverse proxy marks every served HTML document with `<meta name="team-shell" content="1">`. Every row renders only while that marker is present in the document head. Without it the plugin contributes nothing visible — single-user dsh and non-proxied deployments never show the rows.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin registers four `settings.general.item` slot entries: `team-pairing` (order `90`), `team-idle-exempt` (order `95`), `team-message-center` (order `98`), and `team-account` (order `100`, last). The Sign out row is a stateless button whose click handler posts to the same-origin `/api/logout` and then assigns `window.location.href`; the Message Center row is a stateless button whose click handler calls `window.open('/inbox', '_blank', 'noopener')`. The Pairing row owns local state only (idle/busy/ready/error): it posts `POST /api/pairings`, parses `{uuid, expiresAt}`, and builds the claim command from `window.location.hostname`; the copy control uses the shared `writeClipboard` primitive. The Keep-instance-running row reads `idleExempt` from `/api/me` on mount and posts the flipped value to `/api/me/idle-exempt`. The render gate reads the document head synchronously for the team-shell meta marker; the slot entries are always registered (HMR and locale re-registration keep working), and only the visible render is gated. Copy lives in the `settings.teamAccount` locale namespace with complete zh/en dictionaries; the row keys ride the standard slot locale seat.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the settings rows are not enough. They move from the browser rows to the entry, the account service, and the instance session.

- [Team access design](../../../shell/team-access-design.md) — the team account service, login routing, the `/api/logout` dual-clear contract, and the pairing-code mint/claim chain.
- [message-channel-design.md](../../../shell/message-channel-design.md) — the Redis-channel/PostgreSQL-archive message center the Message Center row opens, and its HTTP surface.
- [reverse-proxy.ts](../../../shell/src/reverse-proxy.ts) — the account-mode proxy that injects the team-shell marker and forwards the account endpoints.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current settings rows. They are current package constraints, not a task backlog.

- **Requires the team-shell marker** — the rows render only in a document the team reverse proxy served; other deployments never show them.
- **Web-only** — non-Web clients have no equivalent browser contribution.
- **Pairing code display is transient** — a minted code is shown only for the current render; refreshing the page loses it (mint again, or copy it first).
- **Message Center is a separate page** — the row opens `/inbox` in a new tab; there is no in-session thread view yet.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
