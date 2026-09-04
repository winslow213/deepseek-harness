# Agent Note: Trusted hosts reach the browser privileged surface

Status: implemented

English | [中文](2026-09-03-trusted-host-settings-surface.zh.md)

## Problem

The dsh web UI keeps settings persistence and file-open behind a loopback-only check: `ctx.connection.isLoopback`, the handle the browser privileged surface reads, derives from the page URL hostname, so when the Web GUI serves beyond loopback — an all-interfaces bind reached by a LAN IP literal — every settings surface is terminal-unavailable ("settings are unavailable in this browser") even though the /api browser-trust fence already admits that same authority through `trustedHosts`.

## Decision

Extend the browser privileged-surface classification to trust the deployment's own `trustedHosts` list, the same list the /api fence enforces ([carrier-level browser-trust boundary](../architecture/2026-07-28-api-browser-trust-boundary.md)). The Host connection plugin publishes `trustedHosts` as an index-injection global row (`globalThis.__DSH_TRUSTED_HOSTS__`, injected only when the list is non-empty); the browser connection client classifies the page authority as privileged when it is loopback, the transport declares it owns the host, or the page hostname matches a trusted entry (port-less entries match any port). A page that can reach the authenticated /api channel against a trusted Host is the same page whose settings requests the fence admits, so the injection adds no new authority.

A browser-safe `isTrustedPageAuthority` classifier (`packages/client/connection/src/trusted-hostname.ts`) mirrors the Host-side `isTrustedAuthority` entry semantics in `packages/client/connection/src/api-request-trust.ts`.

## Alternatives considered

- **Keep the privileged surface loopback-only** — rejected: serving the Web GUI beyond loopback is a supported deployment (an all-interfaces bind derives port-less LAN IP literals into `trustedHosts` for the /api fence), so the page-side refusal contradicted the fence rather than guarding anything and left settings read-only-in-memory and file-open unusable for exactly those pages.
- **Pseudo-loopback mapping at the shell reverse proxy** (route B in the [team shell design](../../../../shell/design.md) §7.6: rewrite the page host so the browser sees a loopback hostname) — rejected for this surface: it only works behind that proxy and it masks the real page authority instead of declaring it. Route A, extending the trusted list to the browser surface, was chosen because each per-user instance serves a single user, which keeps the expanded trust low-risk.

## Consequences

- A page whose hostname is a configured or bind-derived `trustedHosts` entry now persists settings and opens files like a loopback page; a hostname the deployment did not list stays terminal-unavailable.
- The browser-side comparison matches on the page hostname only (the client builds its classification URL without the page port), so an explicit `host:port` trusted entry still admits /api traffic but never classifies a page as privileged today; the LAN-serving shape the deployment derives is port-less and matches.
- The injected list rides the existing index-injection channel and appears only when `trustedHosts` is non-empty; loopback and transport-owned pages need no entry. `assertTrustedAuthority` still rejects a non-canonical entry at plugin load, so the page can only ever see entries the fence already accepted.
- The change adds no new configuration surface: deployments configure trust exactly as they did for the /api fence, with `trustedHosts`/`--trusted-host`.
