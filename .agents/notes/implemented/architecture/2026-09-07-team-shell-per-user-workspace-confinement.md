# Agent Note: Per-user workspace confinement in the team shell

Status: implemented

English | [中文](2026-09-07-team-shell-per-user-workspace-confinement.zh.md)

## Problem

Every team-shell account's dsh instance ran against the shared server filesystem. The deployment default `sandbox-policy.workspaceRoot` was `process.cwd()` (the repository root, shared by every account), and the region-router's local `cwd` was the shared `/tmp`. Writes were therefore fenced only against a shared root, and dsh's filesystem sandbox deliberately leaves reads unfenced — so one member could read another member's credentials, sessions, and workspace files.

## Decision

Each account gets a private workspace directory `$DSH_HOME/workspace`, created at provision time and used as the confinement root for both reads and writes.

- **Write boundary.** `provisionUserHome` upserts a second marked block (`dsh-team-sandbox`) into the home patch that overrides `sandbox-policy` with `workspaceRoot: !!js process.env.DSH_WORKSPACE_ROOT`, and `teamChildEnv` sets `DSH_WORKSPACE_ROOT` to the account's workspace. The deployment mode stays operator-controlled via `DSH_PERMISSION_MODE`.
- **Read boundary.** `region-router` (which is already the injected `ctx.fs`) gains a `workspaceRoot` config and fences local `stat`/`lstat`/`readText`/`readBytes`/`listDir` to that root with `FS_PERMISSION_DENIED`. Mounted shadow-tree targets stay remote-served and skip the fence; omitting `workspaceRoot` preserves the bare (non-team) region-router's read-anywhere semantics.
- The region-router/shell `cwd` and the region-router `workspaceRoot` are all set to the account workspace, so relative operations and the default shell workdir land inside the boundary.

## Alternatives considered

**Write fence only (sandbox-policy workspaceRoot).** Rejected as insufficient: dsh's fs sandbox is write-only by design — reads pass through untouched — so a shared server left every account's credentials and session files readable by every other account.

**Kernel-grade read isolation via a separate sandbox backend per user.** Rejected as out of scope: the team shell shares one host kernel, and the in-process read fence in the region-router is the complete answer for the model-controlled-path threat, matching the existing fs-sandbox rationale (containment in trusted code, not a kernel boundary).

**Reuse the existing `--root`-style allowlist from the agent.** Rejected: that allowlist governs the remote agent's own host, not the server-local fs plane the region-router fronts.

## Consequences

Each account can read and write only inside `$DSH_HOME/workspace` plus its mounted shadow roots. The `dsh-team-sandbox` block is idempotent and coexists with the `dsh-team-llm` block and any operator rows in the home patch. Existing accounts gain the workspace directory and patch on their next provision (login); already-running instances need a restart. The read fence applies to the injected region-router only — a member who deletes the generated profile patch falls back to the local providers, so the fence is a team-shell default, not a kernel guarantee.
