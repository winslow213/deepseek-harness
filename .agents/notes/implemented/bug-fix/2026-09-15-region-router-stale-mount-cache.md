# Agent Note: Region-router mount cache subscribes to the hub's push channel

Status: implemented

English | [中文](2026-09-15-region-router-stale-mount-cache.zh.md)

## Problem

`RegionRouterFileSystem` (`shell/src/remote/region-router.ts`) caches the hub's mount table (`mountsCache`) and only refetches it when a shadow path fails to translate (`remoteOf(path) === undefined`). A mount's shadow directory (`shadowPathFor`, `shell/src/remote/hub.ts`) is keyed only by `user` + `agentId` + ordinal — never by the paired `--root` value. So when a Windows agent reconnects under the same `agentId` with a different `--root` (the common case: pairing a new subdirectory, or repairing after a restart), its shadow path is unchanged, and the stale cache entry still translates successfully. The refresh condition never fires, and the router keeps forwarding requests against the old root indefinitely — until the process restarts — producing `path outside allowed roots: <old root>` errors on the agent side once a request needs a path only valid under the new root.

## Decision

The hub (`shell/src/remote/hub.ts`) now exposes `GET /api/mounts/stream`: a long-lived NDJSON connection that writes the current mount table immediately, then writes a fresh one on every event that actually changes it — an agent connecting/pairing (inside `authenticate()`, right after `byAgentId.set(...)`) and an agent disconnecting (inside the socket `'close'` handler, right after `byAgentId.delete(...)`). `client.ts` adds `subscribeMounts(hubBase, onChange)`, which opens that stream and reconnects with a fixed delay on any drop. `RegionRouterFileSystem` replaces its background timer with a `ctx.effect()`-scoped `subscribeMounts()` call that writes straight into `mountsCache` on every pushed line; `refreshMounts()` still runs once at construction as a fast bootstrap ahead of the stream's first message, and `refreshFor()` keeps its original fallback (refetch immediately when a shadow path fails to translate) for the case where the router observes a translation failure before any push has landed.

## Alternatives considered

### Why not a background poll (the previous version of this fix)?

An earlier iteration polled `GET /api/mounts` on a fixed interval (`ctx.effect()` + `setInterval`, default 3 s), mirroring `mount-sync.ts`'s existing pattern. It worked, but it spends CPU and a hub round trip on every tick regardless of whether the mount table ever changes, across every connected instance. The hub already knows the exact two moments the table can change — an agent socket opening or closing — so pushing from those two call sites is strictly more precise and cheaper than sampling on a timer.

### Why not have the hub push an invalidation through `InstanceManager` (kill-and-cold-start)?

An even earlier design considered reaching a live per-user dsh instance by stopping it via `InstanceManager` and letting it cold-start with a fresh cache — but that drops the user's active browser session (open tabs, in-flight requests) just to refresh a filesystem plugin's cache. The streaming-subscription design avoids this entirely: the push channel is a plain HTTP connection from `region-router.ts` to the hub's existing control server, orthogonal to the account service and `InstanceManager`; no session is ever interrupted.

### Why not refetch on every shadow-path access?

That would issue one hub round trip per fs operation on a mounted path, for a condition (a root changing mid-session) that is rare relative to file reads within a session. The push subscription gives immediate freshness without per-operation cost.

## Consequences

- Re-pairing an already-connected agent (or the same physical machine) with a different `--root` takes effect for that instance's region-router the moment the hub's socket handler observes the reconnect — no polling interval, no instance restart.
- An agent disconnecting also pushes a fresh (now agent-absent) mount table, so a stale connection doesn't linger in `mountsCache` either.
- The mount-stream connection is one persistent HTTP request per running region-router instance to the hub's control server; the hub's `close()` must end every open subscriber response before closing the control server, since Node's `http.Server.close()` waits for existing connections to end.
- Regression coverage: `shell/tests/region-router.spec.ts` spins up a fake hub serving `/api/mounts/stream`, pushes a re-paired root through it directly (no timer), and asserts the router's next remote fs call uses the new root as soon as the pushed line lands.
