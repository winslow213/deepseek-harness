# Agent Note: Per-user whitelist against the idle-instance reclaim sweep

Status: implemented

English | [中文](2026-09-16-idle-reclaim-whitelist.zh.md)

## Problem

The account service reclaims a member's spawned `dsh` instance after `TEAM_IDLE_TIMEOUT_SECS` (default 30 minutes) of no proxied traffic, freeing memory on the assumption that a cold restart on next login is cheap. That threshold is a single global setting: an operator who wants one account's instance to stay up regardless of activity (a demo account, a long unattended background task, a user who finds the cold-start latency disruptive) has no way to exempt it without raising the timeout for every account, which defeats the memory-reclaim goal for the other ~200 registered members sharing the host.

## Decision

`dsh_users` gains an `idle_exempt BOOLEAN NOT NULL DEFAULT false` column (schema migration via the existing `ALTER TABLE IF NOT EXISTS` idempotent-migration pattern already used for `dsh_instances.launch_token`/`last_seen_at`). `InstanceStore.idleUsers` — the query the sweep (`InstanceManager.reapIdle`, `shell/src/account/instance-manager.ts`) calls every `IDLE_SWEEP_INTERVAL_SECS` — joins `dsh_instances` to `dsh_users` and excludes rows where `idle_exempt` is true, so an exempted user's instance is never a sweep candidate no matter how stale `last_seen_at` gets. `UserStore.setIdleExempt(userId, exempt)` is the single write path, exposed operator-side through `account-cli set-idle-exempt <username> <on|off>` (`shell/src/account/cli.ts`), matching the existing `reset-password`/`reset-agent-token` operator-CLI pattern rather than adding a new admin HTTP route.

The flag is per-user, not per-instance: it lives on `dsh_users` (identity data) rather than `dsh_instances` (ephemeral registration data that is deleted on every reclaim/stop and recreated on next spawn), so the whitelist survives across stop/start cycles instead of needing to be reapplied after every cold start.

## Alternatives considered

**A per-user idle-timeout override column instead of a boolean exemption.** Rejected: nobody asked for a *longer but still finite* per-user timeout, only for specific accounts to never be swept; a boolean is the simpler mechanism for that need, and a numeric override can be added later without displacing this column if a real per-user timeout requirement appears.

**An admin HTTP endpoint (`PATCH /api/users/:id`) instead of a CLI-only command.** Rejected: every other account-mutation (`create-user`, `reset-password`, `reset-agent-token`) is operator-CLI-only with no HTTP surface; adding one admin route just for this field would be the only mutable-user-field HTTP endpoint in the service, an asymmetry with no other benefit since operators already run the CLI against the same database for account changes.

**Storing the flag on `dsh_instances` instead of `dsh_users`.** Rejected: `dsh_instances` rows are deleted by `InstanceStore.remove` on every stop/reclaim and only reappear via `upsert` on the next spawn, which would silently drop the whitelist the first time an exempted account's instance ever restarted (e.g., after a deploy) — the opposite of the "stays up regardless" guarantee being added.

## Consequences

An operator can now keep specific accounts' instances resident indefinitely without changing the global `TEAM_IDLE_TIMEOUT_SECS`, at the cost of one exempted account's ~270MB baseline RSS staying allocated permanently instead of being reclaimed between sessions — an operator who exempts many accounts trades back the memory-capacity headroom the reclaim sweep exists to provide. No new HTTP surface was added, so exemption still requires direct CLI/database access rather than a self-service UI toggle.
