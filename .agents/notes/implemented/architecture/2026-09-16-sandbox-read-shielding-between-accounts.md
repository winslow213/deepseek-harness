# Agent Note: Read shielding between accounts sharing one host

Status: implemented

English | [中文](2026-09-16-sandbox-read-shielding-between-accounts.zh.md)

## Problem

Colocating several tenants on one host means their data shares a parent directory. In the team-shell deployment every account's home lives under one users root (`/home/winslow/.dsh-users/<account>`), each holding a `.credentials.yaml` with that account's LLM API key and browser-session grant secret, plus session logs and a private workspace. All accounts run as the same OS user, so the kernel offers no boundary between them at all.

The sandbox did not supply one, because it was never asked to. `SandboxMode` bounds **filesystem effects**, and all three modes (`read-only`, `workspace-write`, `danger-full-access`) describe what a command may *modify*. The bwrap profile mounts the host root read-only (`--ro-bind / /`), Landlock granted `readOnly: ['/']`, and Seatbelt opened with `(allow default)` — each an accurate expression of a write-only policy, and each leaving every readable file on the host readable. Measured on the deployment host, a confined `bash` in one account read a sibling account's `.credentials.yaml` in cleartext, and all 24 non-owning accounts were readable the same way.

That is the shape of the defect worth naming: **write confinement is not read isolation**, and a deployment that adopts the first while assuming the second has no boundary at all where it believes it has one.

## Decision

**Add an optional read boundary to the sandbox policy, expressed as denied roots plus re-exposed subtrees, and derive each backend's spelling from one shared helper.**

`SandboxExecutionPolicy` gains `readDeniedRoots` and `readAllowedRoots`. A denied root is hidden together with its whole subtree; an allowed root inside it is re-exposed, which is what keeps the account's own home usable while hiding its siblings. Both are deployment config on `sandbox-policy`, defaulting to absent — an unshielded deployment keeps the inherited read-anywhere semantics, so a single-tenant host is unaffected.

`readShield(policy)` in `dsh-sandbox`'s `roots.ts` is the one home for that meaning, exactly as `writableRoots()` is for the write side: it canonicalizes both lists, drops an allowed root that sits outside every denied root (re-exposing a path nothing hides would widen a read the caller never asked to widen), and refuses to deny `/` (no re-exposure could make that usable). Each backend translates the same pair:

- **bwrap** mounts a `tmpfs` over each denied root, recreates the intervening directories with `--dir`, and `--ro-bind`s the allowed subtrees back, **before** the mode's own mounts. Order is load-bearing in both directions: the shield must precede the re-bind, and a writable workspace living inside a denied root must be bound after the shield, or the read-only re-exposure silently turns it read-only.
- **Seatbelt** appends `(deny file-read* (subpath …))` then `(allow file-read* (subpath …))`, because Seatbelt takes the last matching rule.
- **Landlock** replaces its blanket `readOnly: ['/']` with a system-path allow-list plus the re-exposed subtrees, but **only** when a shield is present — it is an allow-list language and cannot subtract a path from a blanket grant, so an unshielded deployment keeps today's spelling.

**The team-shell deployment hides the users root and re-exposes the account's own home.** The injected `sandbox-policy` patch reads both from the environment (`DSH_USERS_ROOT` and `DSH_HOME`) rather than baking in any path, so the layout stays a deployment choice. Both `!!js` expressions are quoted: an unquoted value beginning with `[` parses as a YAML flow sequence and the trailing `.filter(...)` then fails the entire patch, which stops the account from booting rather than merely dropping its shield.

**The team-shell runs bash through its own sandbox-consuming executor.** The home patch disables the `bash-sandbox` bundle entry and inserts `region-shell` instead, which exists so one `ctx.shell` serves both the local world and every paired agent's mounted root. That executor extends `SandboxBashExecutor`, so it resolves the same policy and applies the same profile — the disabled entry is a double-registration avoidance, not a retreat from confinement. Verified before relying on it: disabling the bundle entry while the router inherits the sandboxed executor is exactly the kind of swap that would silently drop confinement.

## Alternatives considered

**One OS user per account, with its own systemd unit, port, and reverse-proxy route.** Rejected by the account owner: 25 accounts would mean 25 sets of system users, services, and ports, and that maintenance cost is not acceptable for this deployment. It is also not free — the 24 non-owning account directories are `drwxrwxr-x`, so this route would additionally need `chmod 700` on each (including every `workspace/`) before the kernel would hide anything. Recorded here because it is the technically cleanest option and will be proposed again; the per-tenant container/microVM variant is the version of it that could be automated.

**Fixing only the `read` tool's existing fence (`region-router.ts`).** Rejected as insufficient: that fence covers the `FsProvider` path only. A confined `bash` reaches the same files through a subprocess, and the `grep`/`glob` tools do too, through a bare `ctx.subprocess.spawn` that is not confined at all. Three of the four read channels bypass an `FsProvider` fence, so a fence-only fix would leave the reported hole open.

**Denying reads without re-exposing the account's own home.** Rejected: the shield would then also hide the files the account's own tooling loads, so every confined command would fail rather than be isolated.

## Consequences

Read isolation between accounts is now expressed in the sandbox policy itself and enforced by the same backends that already enforce writes, verified against real mounts: a shielded command cannot list a sibling account's directory (the name does not appear), cannot read its `.credentials.yaml` while the same read succeeds unshielded, keeps its own home readable through the shield, keeps its workspace writable despite the workspace living inside the denied root, and keeps `bash`/`node`/`git` working. `readShield()` is covered by unit tests for canonicalization, the allowed-inside-denied rule, the outside-every-denied-root drop, the `/` refusal, and prefix-sibling handling; the mounts are covered by four new `bwrap.e2e.ts` cases.

**This is application-layer containment, not a kernel boundary.** Every process still runs as the same OS user, so it holds against a tenant's agent reaching its peers through the provided tools — the reported threat — and not against a plugin spawning a process outside the sandbox seam, a session in `danger-full-access`, the host process itself, or any code path that does not consult `ctx.sandbox`. A hostile-tenant threat model requires containers or microVMs.

**Landlock is not e2e-verified on this host.** The `landlock-run` static launcher is absent from the development checkout (the platform package ships only the Node-API flock addon), so bwrap is the active rung here; the Landlock grant derivation is unit-covered and `landlock.e2e.ts` owns the runtime proof in CI. Narrowing its system allow-list is the one part of this change that can break a working shell if a needed path is omitted, which is why it is confined to the shielded case and covered by its own suite.

**The `grep`/`glob` search tools are confined through the same seam.** These tools spawn ripgrep through a bare `ctx.subprocess.spawn`, so `rg` reads files on the tool's behalf with no sandbox at all — the third of four read channels, and the one a sandbox-only fix would have missed. `runRipgrep` now wraps its argv through `ctx.sandbox` with the calling session's policy, so the search tools and `bash` agree on where a session may read. The services are read optionally (`ctx.get`) rather than injected: searching files has no inherent need for a sandbox stack, and compositions exist that mount these tools with no provider, where a hard dependency would stop them loading. When a sandbox *is* mounted, confinement is not optional — the policy applies, and a runner that cannot confine fails the search rather than falling back to an unconfined `rg`.

**Rotating the exposed credentials is out of scope and still required.** Closing the read channel does not make an already-disclosed key secret again.
