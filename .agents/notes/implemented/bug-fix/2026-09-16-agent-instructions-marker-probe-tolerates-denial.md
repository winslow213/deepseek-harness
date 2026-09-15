# Agent Note: Project-root marker probes tolerate a denied path instead of crashing the walk

Status: implemented

English | [中文](2026-09-16-agent-instructions-marker-probe-tolerates-denial.zh.md)

## Problem

`findProjectRoot` (`packages/context/agent-instructions/src/files.ts`) walks upward from the session cwd looking for a project-root marker (`.git` by default), stopping at the first directory that has one or at the filesystem root. `existsAsMarker`, the per-directory probe it calls, only treated `FS_NOT_FOUND` (through a `ctx.fs` provider) or `ENOENT`/`ENOTDIR` (through the host `node:fs/promises`) as "marker absent, keep walking" — every other error, including a permission denial, was rethrown and aborted the walk entirely. `findProjectRoot` runs on effectively every turn (it feeds baseline instruction discovery), and its walk always continues above the session cwd toward the filesystem root by design, with no built-in knowledge of any read boundary a `ctx.fs` provider might enforce.

The team-shell region-router (see the [workspace confinement note](../architecture/2026-09-07-team-shell-per-user-workspace-confinement.md)) fences local reads to the account's private `workspaceRoot` and denies `stat` outside it with `FS_PERMISSION_DENIED`. Because `findProjectRoot`'s walk always steps one level above the session cwd — which is the account's workspace root in a team-shell session — the very first marker probe past that boundary hit this fence and crashed the entire turn. The same shape of failure can happen with a plain host filesystem: a directory the host process lacks OS permission to `stat` (`EACCES`) rethrows instead of letting the walk continue upward.

## Decision

`existsAsMarker`'s error classification now treats a permission denial the same as "not found" on both paths: `isMissingProviderPathError` also matches `FS_PERMISSION_DENIED`, and `isMissingPathError` also matches `EACCES`. A denied marker probe means the same thing to `findProjectRoot` as a missing one — it cannot confirm the marker exists there, so it keeps climbing — and a probe genuinely denies existence information either way, so tolerating the denial does not leak anything the walk could otherwise see. Any other error (a genuine I/O failure, e.g. `EIO`, or an unclassified provider error) still rethrows, since those represent a real inability to answer the walk rather than a boundary the caller is expected to encounter.

## Alternatives considered

### Why not fix this only in the region-router (make `stat` return "not found" for boundary denials generally)?

The team-shell workspace-confinement note explicitly documents `stat` denying outside `workspaceRoot` as intended, and other local callers may rely on that denial being visible as an error rather than silently becoming "not found". Fixing the classification in the marker-probe caller keeps the fs seam's stated contract intact while making the one caller that walks upward by design (and has no reason to distinguish "denied" from "absent") tolerant of it. A plain host EACCES needed the identical treatment and is outside the region-router's reach entirely, which the caller-side fix covers uniformly.

### Why not have `findProjectRoot` stop climbing at the first denial instead of continuing past it?

Stopping would silently fall back to `cwd` even when an ancestor directory further up does hold the project root and is otherwise readable — indistinguishable, from the walk's perspective, from a marker simply not being present at the denied level. Continuing to climb (treating denial as "no marker here, keep going") matches how the walk already treats "not found" and lets it still find a project root above an inaccessible directory, which is the outcome the reported case needed.

## Consequences

- A team-shell session's baseline-instruction discovery no longer crashes the turn when its default upward walk steps past the account's `workspaceRoot` fence; it now finds the project root at or below that boundary as if the level above simply had no marker.
- A host directory the process cannot `stat` (`EACCES`) is likewise tolerated during the walk instead of aborting instruction discovery.
- Any other stat failure (a real I/O error, or a provider error that isn't `FS_NOT_FOUND`/`FS_PERMISSION_DENIED`) still propagates and aborts the walk, preserving the existing "surfaces marker lookup failures instead of crossing into an ancestor project" behavior for genuine failures.
- Regression coverage in `packages/context/agent-instructions/tests/agent-instructions.spec.ts`: one test per path (provider `FS_PERMISSION_DENIED`, host `EACCES`) confirms the walk now crosses into the ancestor project instead of throwing, alongside the existing and a new genuine-failure test per path confirming a real error still throws.
