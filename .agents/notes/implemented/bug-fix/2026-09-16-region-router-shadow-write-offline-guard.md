# Agent Note: shadow-tree writes with no live mount silently landed on local disk

Status: implemented

English | [中文](2026-09-16-region-router-shadow-write-offline-guard.zh.md)

## Problem

`RegionRouterFileSystem.writeText`/`editText` (`shell/src/remote/region-router.ts`) each resolve `shadowTarget(target)`; when it returns a translation, the operation is forwarded to the owning remote agent. When it returns `undefined`, both methods fell through to `super.writeText`/`super.editText` — the inherited **local** filesystem implementation — with no further check.

For reads, an unmatched shadow-tree path falling back to ordinary local semantics is the correct, already-documented behavior (`2026-09-16-region-router-shadow-probe-permission.md`): a miss there is harmless, since the path is either genuinely absent or the caller is walking upward past a mount boundary looking for a marker file. Writes have no equivalent safe interpretation: `shadowTarget` returns `undefined` whenever the path's agent is offline, not yet paired, or was re-paired under a different root, and in every one of those cases the caller believes it is writing to the mounted machine. Falling through to a local write instead silently created real files on the server's disk at the shadow path — content that was never sent to the actual remote root and that the model, and the user, believed lived there. Left unnoticed across sessions, this accumulated hundreds of megabytes of real project content directly on the server under `/tmp/dsh-shadow/<user>/<agentId>/...`, entirely decoupled from the paired machine's actual state.

## Decision

Add `assertShadowWriteRoutable(target)`: if `target.displayPath` is under the shadow root (`isShadow`) and `shadowTarget` did not resolve a live mount, throw `FsError(..., 'FS_IO_ERROR')` naming the offline/unpaired agent, instead of falling through to `super.writeText`/`super.editText`. A path outside the shadow root entirely is unaffected and keeps ordinary local write semantics, matching the read-side asymmetry that is intentional: reads treat "not routable" as "not found" because that's a safe default, writes treat it as a hard failure because silently landing bytes on the wrong machine is not.

## Alternatives considered

### Why not make writes fail-soft like reads (e.g. queue or buffer until the agent reconnects)?

A write the caller believes succeeded, but that is actually queued rather than delivered, is a worse silent-divergence hazard than the one this fix removes — the model would proceed as if content it wrote is now on the remote machine (for example, referencing a file it just "created" in a later shell command that only the remote agent can run) when nothing has left the server yet. Failing loudly lets the caller retry once the agent is back online, or explains a currently-offline mount rather than pretending it worked.

### Why not delete the local-disk residue produced by this bug automatically as part of the fix?

The affected paths (`hello`, `OH_Hap`, `test` under `/tmp/dsh-shadow/winslow/pairing@WH-D-010484A/` on this deployment) are operational data, not source-controlled state; removing them is an operator action taken directly on the affected server, not a code change this note's commit can express or verify.

## Consequences

- A write/edit attempted on a shadow-tree path whose agent is offline, unpaired, or re-paired under a different root now fails immediately with `FS_IO_ERROR`, instead of silently creating divergent content on the server's local disk.
- Paths outside the shadow root are unaffected: they keep the inherited local sandboxed write semantics.
- Regression coverage: `shell/tests/region-router.spec.ts` writes to a shadow-tree path with no live mount and asserts both the thrown `FS_IO_ERROR` and that nothing was created on local disk.
- Pre-existing local residue from before this fix is not cleaned up by the code change itself; it was removed as a one-time operational cleanup on the affected deployment.
