# Agent Note: `assertLocalReadable` treats any shadow-tree path as an ordinary local probe

Status: implemented

English | [中文](2026-09-16-region-router-shadow-probe-permission.zh.md)

## Problem

`RegionRouterFileSystem` (`shell/src/remote/region-router.ts`) enforces a workspace-boundary fence on every local (non-remote) path through two parallel private checks: `assertLocalPathReadable(abs)` (used only by `lstat`) and `assertLocalReadable(target)` (used by `stat`, `readText`, `readBytes`, `readByteRange`, `listDir`). Only the first already skipped the fence for any path under the account's shadow root (`isShadow(abs)`); the second skipped it only when the path matched a *currently live* mount (`shadowTarget(target) !== undefined`), otherwise throwing `FS_PERMISSION_DENIED`. A path under the shadow root that isn't the account's private workspace and isn't a live mount — for example `/tmp/dsh-shadow/<user>/.git`, produced when a caller walks upward from a mounted directory looking for a repository-root marker, or a directory left behind by an earlier pairing under a different root — is exactly this unmatched case. Because `stat` is a routine existence probe (unlike `lstat`, which already tolerated it), the asymmetry surfaced as a hard `path outside allowed roots`-style crash that failed the entire model turn instead of a plain "not found."

## Decision

`assertLocalReadable` now also skips the fence when `this.isShadow(target.displayPath)` is true, mirroring `assertLocalPathReadable`'s existing behavior exactly. An unmatched shadow-tree path is neither the account's private workspace nor a live mount, so treating it as an ordinary local miss (letting `stat` return `undefined`, `readText`/`readBytes` throw `ENOENT`, etc.) is safe: it is still scoped to that same account's own historical shadow directory, never another tenant's data, and it only changes probes of "not found" content into an actual "not found" response instead of a permission error.

## Alternatives considered

### Why not narrow the skip to only the exact shadow path of a currently-live mount?

`shadowTarget(target) !== undefined` already is that precise, live-mount-aware check, and `assertLocalReadable` keeps it as its first, primary skip condition. The problem is specifically the paths that fail that precise check yet are still under the broad shadow root — stale residue from an earlier pairing, or a caller's upward walk past the live root. Narrowing further would leave exactly the crash this note fixes in place.

### Why not have callers avoid probing above the mounted root instead?

The failing probe in the reported case was a generic upward directory walk (e.g. locating a `.git` marker) that has no knowledge of, or reason to know about, the shadow-tree boundary; changing that caller behavior is neither practical nor this fix's responsibility. The region-router's fence is the right place to decide what "not found" means for paths it does not own.

## Consequences

- `stat`, `readText`, `readBytes`, `readByteRange`, and `listDir` now behave consistently with `lstat` for any path under the shadow root, whether or not it corresponds to a currently live mount.
- A caller's upward directory walk (e.g. locating a `.git` marker) starting from inside a mounted directory no longer crashes the turn when it steps above the currently paired root; it now observes ordinary "not found" semantics.
- Stale shadow-tree residue from a prior pairing under a different root (still present on disk under `/tmp/dsh-shadow/<user>/<agentId>/...` until cleaned up separately) is likewise probed as ordinary local content rather than denied outright.
- Regression coverage: `shell/tests/region-router.spec.ts` resolves a shadow-tree path with no live mount match and asserts `stat()` returns `undefined` instead of throwing.
