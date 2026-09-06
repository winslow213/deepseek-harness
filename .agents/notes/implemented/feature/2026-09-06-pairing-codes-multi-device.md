# Agent Note: Pairing codes and multi-device mounting

Status: implemented

English | [中文](2026-09-06-pairing-codes-multi-device.zh.md)

## Problem

A member could not mint a pairing code from the dsh web UI, so mounting a code host required an operator-side `dsh-shell remote pair` with the member's agent token. The hub also enforced one agent per user (`byUser` evicted the previous socket) and one-time pairing codes, so a single member could not mount workspaces from several devices. The hub's static `--user-token` table drifted from the account database's authoritative `agent_token`.

## Decision

The account service owns pairing codes. `POST /api/pairings` (session-authenticated, proxied like `/api/me`) mints a code in Redis (`dsh-pairing:<uuid>`, 30-minute TTL, `TEAM_PAIRING_TTL_SECS`) and returns only `{uuid, user, expiresAt, ttlMs}` — never the agent token. The hub verifies a claimed code by calling `POST /api/pairings/claim` (loopback, operator-secret guarded), which returns the member's `agent_token`; the hub then binds the agent, issues that token as its reconnect token, and learns it into its token map so a later `--user/--token` reconnect works.

A code is multi-use within its TTL: the claim path never deletes the Redis key. The hub now registers several agents per user (`byUser` is a list; a duplicate agent id still replaces itself), and `exec`/`fs`/`fs-read`/`kill` accept an optional `agentId` to disambiguate — omitted with several agents online returns 409. The region-router filesystem and region-shell executor thread the owning agent id from the shadow path.

The browser row lives in `packages/client/ui-team-account` beside the Sign out row: it posts to the same-origin `/api/pairings`, then shows the code, the claim command (`dsh-shell remote agent --pair <uuid> --hub <host>:7101 …`), and a copy control.

## Alternatives considered

**Hub-minted codes: the account service pushes the code into the hub's `/api/pairings`.** Rejected because that endpoint proves the agent token and keeps the hub's static token table as the mint authority, so it would not remove the DB/hub token drift, and the hub's in-memory map still implies one-time codes.

**One-time code per device.** Rejected because "one code mounts several devices" requires reuse within the TTL; a spent-code error after the first device would force the member back to the web for every additional device.

**Host pairing remote (browser → host → account → hub).** Rejected as over-abstraction: the account service is already reachable through the proxy like `/api/me`, and a host `pairing.mint()` remote plus `config.user` injection adds surface without removing any trust the direct proxy path lacks (the agent token never reaches the browser either way).

## Consequences

The agent token stays server-to-server (hub ↔ account). One code mounts several devices within its TTL. The hub learns tokens on claim, closing the S3 static-token gap for paired users without a startup DB load. Callers that previously addressed the single agent by `user` now must pass `agentId` when several agents are online; the hub returns 409 instead of guessing. The remote agent remains zero-dependency.
