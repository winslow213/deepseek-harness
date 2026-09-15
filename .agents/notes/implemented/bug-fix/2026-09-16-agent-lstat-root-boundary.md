# Agent Note: `lstat` on a mounted root always failed its own boundary check

Status: implemented

English | [中文](2026-09-16-agent-lstat-root-boundary.zh.md)

## Problem

`shell/src/remote/agent.ts`'s `runFsOp` whitelists every `fs:op` request against `session.realRoots` (the realpath-resolved `--root` arguments the operator configured for a mount). Every op except `lstat` calls `resolveUnderRoot(req.path, session.realRoots)` directly. `lstat` instead resolved `dirname(req.path)` and re-appended the literal final component, so a symlink at the requested path itself is reported rather than followed.

That parent-based check breaks precisely when `req.path` is a mounted root itself: the root's own parent directory is, by construction, one level above the allowlist boundary, so `resolveUnderRoot(dirname(req.path), realRoots)` always throws `path outside allowed roots`. `region-router.ts`'s `lstat()` override dispatches exactly this request — `remotePath = mount.root` with no relative suffix — whenever it lstats a shadow path that matches a live mount with no subpath, which is the shadow root's own listing/validation case. The result: `lstat` on the mounted root itself was unconditionally broken, on every mount, since this remote-agent architecture was first built. The error message used the untranslated `dirname(req.path)` value, so it read as if a directory one level short of the configured root was missing, which obscured the real cause.

## Decision

Extract the resolution into `resolveLstatTarget(absPath, realRoots)`: try the existing parent-based, non-follow-preserving resolution first; if and only if it fails because the boundary check rejected the *parent* path (error message starts with `path outside allowed roots`), fall back to resolving `absPath` itself via `resolveUnderRoot` and probe that. The fallback still enforces the identical allowlist — `resolveUnderRoot` — so it cannot admit anything not already permitted; it can only recover the one case the parent-based path structurally cannot express (the request path equals a root). Because the root itself is an operator-configured path, not attacker-controlled, treating a symlink at the root the same as any other file within it (i.e., following it in this one exact-root case) is an acceptable relaxation.

## Alternatives considered

### Why not special-case `absPath === root` directly instead of catching the specific error message?

Matching on the boundary-rejection message keeps the fallback triggered by the actual failure mode rather than by re-deriving root-equality separately; `session.realRoots` can have realpath-resolved forms that don't string-equal the raw request path even when they denote the same location (e.g. differing case on Windows drive letters), so re-deriving equality risks silently missing exactly the case this fix targets.

### Why not always resolve `absPath` directly for `lstat` and drop the parent-based check entirely?

That would follow a symlink at the final path component on every `lstat`, defeating the operation's purpose (reporting a symlink at the target instead of what it points to) for every nested path, not just the mount root. The fallback is scoped narrowly to the one case the parent-based approach cannot express.

## Consequences

- `lstat` on a mounted root now succeeds, matching `stat`/`resolve`/`readText`/etc., which never had this asymmetry.
- `lstat` on any other path retains prior non-follow-symlink semantics unchanged.
- A path genuinely outside every allowlisted root still fails both the parent-based attempt and the fallback, so the boundary itself is unweakened.
- Regression coverage: `shell/tests/agent.spec.ts` exercises `resolveLstatTarget` directly for (a) the root-itself case, (b) a nested symlink whose final component must stay literal, and (c) a path genuinely outside every root.
- This fix runs on the remote agent binary/script itself (the code executing on the paired Windows machine), not the dsh server, so it only takes effect once the user re-pairs or restarts their local agent process with updated code — unlike the two preceding fixes in this series, which took effect via server-side redeploy alone.
