# Agent Note: Per-user whitelist against the idle-instance reclaim sweep

Status: implemented

English | [中文](2026-09-16-idle-reclaim-whitelist.zh.md)

## Problem

The account service reclaims a member's spawned `dsh` instance after `TEAM_IDLE_TIMEOUT_SECS` (default 30 minutes) of no proxied traffic, freeing memory on the assumption that a cold restart on next login is cheap. That threshold is a single global setting: an operator who wants one account's instance to stay up regardless of activity (a demo account, a long unattended background task, a user who finds the cold-start latency disruptive) has no way to exempt it without raising the timeout for every account, which defeats the memory-reclaim goal for the other ~200 registered members sharing the host.

## Decision

`dsh_users` gains an `idle_exempt BOOLEAN NOT NULL DEFAULT false` column (schema migration via the existing `ALTER TABLE IF NOT EXISTS` idempotent-migration pattern already used for `dsh_instances.launch_token`/`last_seen_at`). `InstanceStore.idleUsers` — the query the sweep (`InstanceManager.reapIdle`, `shell/src/account/instance-manager.ts`) calls every `IDLE_SWEEP_INTERVAL_SECS` — joins `dsh_instances` to `dsh_users` and excludes rows where `idle_exempt` is true, so an exempted user's instance is never a sweep candidate no matter how stale `last_seen_at` gets. `UserStore.setIdleExempt(userId, exempt)` is the single write path, with two callers: the operator-side `account-cli set-idle-exempt <username> <on|off>` (`shell/src/account/cli.ts`, any account) and the session-scoped `POST /api/me/idle-exempt` (`shell/src/account/http.ts`, the signed-in member's own account only, resolved the same way `/api/pairings` resolves its caller via `sessionUser`). `GET /api/me` reports the flag back as `user.idleExempt` so the settings row can render its current state.

The flag is per-user, not per-instance: it lives on `dsh_users` (identity data) rather than `dsh_instances` (ephemeral registration data that is deleted on every reclaim/stop and recreated on next spawn), so the whitelist survives across stop/start cycles instead of needing to be reapplied after every cold start.

The client half is a Settings → General row (`packages/client/ui-team-account/src/client/IdleExemptRow.tsx`, registered alongside the existing Pairing code and Sign out rows in the same package) that reads the flag from `/api/me` on mount and flips it through `POST /api/me/idle-exempt` via a `Switch` control, gated on the same `<meta name="team-shell">` marker the other two rows check.

## Alternatives considered

**A per-user idle-timeout override column instead of a boolean exemption.** Rejected: nobody asked for a *longer but still finite* per-user timeout, only for specific accounts to never be swept; a boolean is the simpler mechanism for that need, and a numeric override can be added later without displacing this column if a real per-user timeout requirement appears.

**An admin HTTP endpoint (`PATCH /api/users/:id`) that mutates an arbitrary account by id.** Rejected: every other account-mutation (`create-user`, `reset-password`, `reset-agent-token`) is operator-CLI-only with no HTTP surface; adding an admin route that can set this field on any user id would be the only mutable-arbitrary-user-field HTTP endpoint in the service. The self-service `/api/me/idle-exempt` route that shipped instead is narrower in kind, not degree: it resolves its target from the caller's own session (like `/api/pairings`), so it can never mutate another account, and needs no `adminSecret` gate.

**Storing the flag on `dsh_instances` instead of `dsh_users`.** Rejected: `dsh_instances` rows are deleted by `InstanceStore.remove` on every stop/reclaim and only reappear via `upsert` on the next spawn, which would silently drop the whitelist the first time an exempted account's instance ever restarted (e.g., after a deploy) — the opposite of the "stays up regardless" guarantee being added.

## Consequences

Any signed-in member can now keep their own instance resident indefinitely without operator involvement, at the cost of one exempted account's ~270MB baseline RSS staying allocated permanently instead of being reclaimed between sessions — because the toggle is self-service rather than operator-gated, the memory-capacity headroom the reclaim sweep exists to provide now depends on how many members choose to flip it, not on operator policy alone. An operator can still audit or force-clear the flag directly (`account-cli set-idle-exempt <username> off`) if capacity pressure requires it.
