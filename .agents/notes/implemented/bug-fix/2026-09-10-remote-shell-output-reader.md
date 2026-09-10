# Agent Note: Remote shell process exposes independent output readers

Status: implemented

English | [中文](2026-09-10-remote-shell-output-reader.zh.md)

## Problem

The A2UI live-result panel called `proc.createOutputReader()` on a background shell process and hit `TypeError: proc.createOutputReader is not a function`. The capability seam's `ShellProcess` interface requires `createOutputReader(): ShellProcessReader` — an independent, non-consuming cursor so a second consumer (a live-result stream) can follow output without consuming the primary `readOutput` delta. The local providers (`bash-local`, `pwsh-local`) implemented it, but the remote executor's `background()` returned a `ShellProcess` with only `readOutput`, so any live-result consumer over a mounted (remote-agent) command crashed.

## Decision

`RemoteShellCore.background()` in `shell/src/remote/executor.ts` now builds readers through a `makeReader()` closure that owns its own stdout/stderr offsets over the two capped streams, mirroring `bash-local`. `readOutput` is the primary reader and `createOutputReader()` returns a fresh independent reader, so multiple consumers never interfere. The one-shot provider-failure note is routed through a shared `consumeSpawnError()` so it is delivered exactly once, by whichever read path polls it first.

## Alternatives considered

### Why not route the live-result panel through `readOutput`?

The panel's reader must not consume the tool's own `readOutput` cursor, or the primary consumer would miss output. The seam contract already defines `createOutputReader` for exactly this, so the fix belongs on the provider, not the consumer.

### Why not disable the live-result panel for mounted commands?

That would silently degrade product-visible behavior (no live panel for the mounted case) instead of fixing the missing capability. Mounted and local commands should behave alike.

## Consequences

- Live-result streams now attach to mounted commands without throwing; the panel receives incremental output through its own cursor.
- The primary `readOutput` cursor is unchanged for existing consumers.
- No daemon restart is required: `executor.ts` runs inside per-user dsh instances (copied to the profile by `injectRegionRouter`), so the refreshed copy loads on the next instance start.
