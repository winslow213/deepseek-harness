# Agent Note: Idle reclaim and logout-close for per-user instances

Status: implemented

English | [中文](2026-09-06-instance-idle-reclaim-logout.zh.md)

## Problem

A member's dsh web instance ran from login until account-service shutdown: there was no probe, idle timeout, or logout hook, so 30 logged-in members meant 30 resident instances (~435MB each) that only a service restart released. The S6 lifecycle goal (full-spawn-on-demand, zero processes when a member has no active session) needed two pieces first — an activity signal and an explicit logout close.

## Decision

Activity is tracked through the existing route decision, not a new endpoint. `dsh_instances` gains a `last_seen_at` column (defaulting `now()`, added idempotently for existing tables). The proxy already calls `/api/session/route` on every forwarded request, so `handleSessionRoute` refreshes `last_seen_at` via `InstanceStore.touch` whenever it resolves an instance — a live session therefore never crosses the idle threshold. `InstanceManager` runs a 60-second unref'd sweep that selects `InstanceStore.idleUsers(idleTimeoutSecs)` and `stop()`s each, releasing supervisor + dsh web + port. The timeout is `TEAM_IDLE_TIMEOUT_SECS`, defaulting to 30 minutes.

Logout closes the instance deterministically. `/api/logout` resolves the session to a user before destroying it, then calls `InstanceManager.stop(userId)`, which stops the supervisor, frees its reserved port, and removes the registration. `SupervisedInstance` now exposes `port` so the manager can release the reservation it owns.

## Alternatives considered

**Track activity in Redis (`active:<user>` TTL) and reclaim via pub/sub.** Rejected for this scope: the account service already owns the `dsh_instances` row and the proxy already hits a per-request route decision, so a DB column folded into that path needs no new proxy dependency, no pub/sub channel, and no extra endpoint.

**Reclaim on a Redis key-expiry notification instead of a sweep timer.** Rejected: keyspace notifications are opt-in and not guaranteed, whereas a sweep against a timestamped column is a single deterministic query.

**Only close the instance when the last session ends.** Rejected as over-specified for now: a member's logout closing the single per-user instance matches the requested behavior and the S6 "zero processes when inactive" goal; multi-browser sessions sharing one instance can be revisited if it proves disruptive.

## Consequences

A member's logout now reclaims their instance, and a member idle past `TEAM_IDLE_TIMEOUT_SECS` is reclaimed on the next sweep and cold-starts on their next login. The proxy stays Redis-free. Cold-start-on-demand (route returning `instance: null` triggering a spawn) is deliberately not yet implemented: a session with no instance still shows the not-ready page and is spawned on the next login via `ensure`. The sweep timer is unref'd so it never holds the process open, and `stopAll` clears it on shutdown.
