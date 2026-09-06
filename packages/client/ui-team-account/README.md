---
description: "General-settings rows for team-shell deployments: a Sign out row that posts to /api/logout, and a Pairing code row that mints a multi-device pairing code through /api/pairings; both render only under the team-shell marker."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-team-account

English | [中文](README.zh.md)

## Summary

This package adds two rows to Web Settings General: **Pairing code** (生成配对码) and **Sign out** (退出登录). Both appear only when the served document carries the `<meta name="team-shell">` marker that the team reverse proxy injects, so a plain single-user dsh deployment stays unchanged.

The **Sign out** row posts to the same-origin `/api/logout` — the proxy answers by clearing both the team session and the dsh instance cookie — and then navigates to `/`, where the unauthenticated entry serves the login page. The **Pairing code** row posts to the same-origin `/api/pairings` (proxied to the account service, session-authenticated), then shows the minted code, the claim command to run on each device, and a copy control; the code is multi-use within its TTL so one code can mount several devices.

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

Mount this plugin in the browser composition beside the settings packages; the Pairing code row then appears in General settings (before Sign out) when the document was served by the team shell. In any other deployment both rows are absent.

### The Sign out row

The whole cell is the tap target: a localized title and hint on the left, a chevron on the right. A click posts `POST /api/logout` (credentials included, same origin) and navigates to `/` on response. A failed request still navigates, so the entry re-authenticates the member rather than leaving them on a page whose session is already gone.

### The Pairing code row

Clicking the row posts `POST /api/pairings` and expands an inline panel with the minted code, its expiry, the claim command (`dsh-shell remote agent --pair <uuid> --hub <host>:7101 --root <dir> [--allow-command ...]`), and copy controls for both. The code never appears in a session log and the agent token never reaches the browser — the account service keeps it server-side.

### When they appear

The team reverse proxy marks every served HTML document with `<meta name="team-shell" content="1">`. Both rows render only while that marker is present in the document head. Without it the plugin contributes nothing visible — single-user dsh and non-proxied deployments never show the rows.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin registers two `settings.general.item` slot entries: `team-pairing` (order `90`) and `team-account` (order `100`, after it). The Sign out row is a stateless button whose click handler posts to the same-origin `/api/logout` and then assigns `window.location.href`. The Pairing row owns local state only (idle/busy/ready/error): it posts `POST /api/pairings`, parses `{uuid, expiresAt}`, and builds the claim command from `window.location.hostname`; the copy control uses the shared `writeClipboard` primitive. The render gate reads the document head synchronously for the team-shell meta marker; the slot entries are always registered (HMR and locale re-registration keep working), and only the visible render is gated. Copy lives in the `settings.teamAccount` locale namespace with complete zh/en dictionaries; the row keys ride the standard slot locale seat.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the sign-out and pairing surfaces are not enough. They move from the browser rows to the entry and the instance session.

- [Team access design](../../../shell/team-access-design.md) — the team account service, login routing, the `/api/logout` dual-clear contract, and the pairing-code mint/claim chain.
- [reverse-proxy.ts](../../../shell/src/reverse-proxy.ts) — the account-mode proxy that injects the team-shell marker, answers `/api/logout`, and forwards `/api/pairings` to the account service.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current sign-out and pairing surfaces. They are current package constraints, not a task backlog.

- **Requires the team-shell marker** — the rows render only in a document the team reverse proxy served; other deployments never show them.
- **Web-only** — non-Web clients have no equivalent browser contribution.
- **Pairing code display is transient** — a minted code is shown only for the current render; refreshing the page loses it (mint again, or copy it first).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
