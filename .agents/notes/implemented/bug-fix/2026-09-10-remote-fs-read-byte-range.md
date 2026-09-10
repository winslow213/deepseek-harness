# Agent Note: Remote filesystem serves byte-range reads

Status: implemented

English | [中文](2026-09-10-remote-fs-read-byte-range.zh.md)

## Problem

The filesystem seam's `FileSystem` abstract class added `readByteRange(target, { offset, length })`, but the remote provider (`shell/src/remote/fs-provider.ts`) never implemented it, so `RemoteFileSystem` failed typecheck as a non-abstract subclass. The local provider reads a bounded window through `readByteWindow`; the remote agent had no wire op for it, and the hub/client/protocol chain had no way to carry the window.

## Decision

The byte-range read is threaded through every hop of the remote fs path:

- `agent-fs.ts` gains `readByteRange(absolutePath, offset, length)`, mirroring the local `readByteWindow` semantics: regular-file check, no decoding or binary rejection, empty result for `length === 0` or a window past EOF, bounded buffer (only `length` bytes ever held).
- `protocol.ts` adds `readByteRange` to `FsOpRequest.op` with `offset`/`length` fields.
- `agent.ts` handles `case 'readByteRange'` and returns the window as base64.
- `hub.ts` forwards `readByteRange` and relays `offset`/`length`; `client.ts` widens `FsOpSpec`.
- Both remote providers implement the override: `fs-provider.ts` (`RemoteFileSystem`, the `remote inject` path) and `region-router.ts` (`RegionRouterFileSystem`, the region-router path) — the latter forwarding shadow-tree targets to the owning agent and delegating local targets to the inherited `readByteRange`.

## Alternatives considered

### Why not synthesize a range from a whole-file `readBytes`?

That would fetch the entire file (up to the `maxBytes` cap) and slice client-side, defeating the window's purpose — reading only the requested bytes of an arbitrarily large file without buffering the rest.

### Why not leave it unimplemented and relax the subclass check?

The seam contract requires the method; omitting it only hides a capability gap that a real caller (binary/partial file reads) would hit at runtime, the same way the remote shell's missing `createOutputReader` surfaced.

## Consequences

- `RemoteFileSystem` now satisfies the full `FileSystem` abstract surface; the executor tsconfig is clean.
- Byte-range reads over a mounted root are bounded: a caller can pull a window of a large remote file without transferring the whole file.
- No daemon restart is required — `fs-provider.ts` runs inside per-user dsh instances, and the agent-side `agent-fs.ts`/`agent.ts` change takes effect when the user redeploys their mount agent (bundled `dsh-mount-agent`).
