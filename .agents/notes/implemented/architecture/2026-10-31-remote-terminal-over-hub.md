# Agent Note: Terminals run on the paired device

Status: implemented

English | [中文](2026-10-31-remote-terminal-over-hub.zh.md)

## Problem

[Terminals confined to mounted device workspaces](2026-10-28-mount-scoped-terminals.md) stopped a mounted Session's terminal from presenting a server shell as the member's machine, but it left the terminal a server shell: `terminal-controller` allocates through `ctx.subprocess.spawnTerminal`, and the only `ctx.subprocess` in a team deployment is `subprocess-local` on the Host. A member who opened a terminal on their own mount got a shell whose every visible path was the shadow copy, so editing a file from that terminal changed a synchronised copy rather than the device.

The wire protocol could not express a terminal. It carried `exec`, `kill` and `fs:*` frames, and `exec` is one-shot: it spawns a process group, streams its stdout/stderr and reports an exit. A terminal needs interactive stdin, window dimensions, and output that is a byte stream rather than a line stream.

## Decision

The protocol gains terminal frames: `pty:open`, `pty:write`, `pty:resize` from the hub, and `pty:opened`, `pty:data`, `pty:exit` from the agent. The hub exposes `/api/pty`, `/api/pty-write` and `/api/pty-resize` beside `/api/exec`; the open request streams NDJSON like an exec, and write/resize answer immediately because a terminal ends through its own exit frame. Output travels base64-encoded inside JSON lines so a multi-byte character split across chunks survives the round trip.

The agent serves terminals with `node-pty`, loaded on first allocation so a deployment that never opens a terminal never pays for the native module. Allocation is gated by the same two allowlists `exec` enforces — `argv[0]`'s basename must be permitted and `cwd` must resolve under a served root — because a terminal is strictly more powerful than one exec. A channel that closes kills every terminal it allocated, since an orphaned shell would keep running on the member's machine with nobody holding its handle.

A new `region-subprocess` provider replaces `subprocess-local` in provisioned profiles. It extends the local provider and overrides only `spawnTerminal`: a terminal whose `cwd` is the shadow root or beneath it is allocated on the paired agent, and every other call keeps local semantics. Routing keys on `spec.cwd` because that is the one execution-world argument the terminal seam carries; shell discovery stays on the Host (`terminalEnvironment()` and `resolveExecutable()` take no directory), so a device without that exact executable path fails the allocation instead of silently substituting a different shell.

## Alternatives considered

**Replace `ctx.subprocess` wholesale with a remote provider.** Rejected: `exec`, piped `spawn`, executable lookup and shell-environment inspection have no remote counterpart in this protocol, so replacing the service would break `tool-fs-search`, `lsp-stdio` and the subagent tools in every Session rather than routing one surface. Extending the local provider keeps the change to the one method with a device equivalent.

**Route terminals by an explicit execution-world field on the spawn spec.** Rejected: the terminal seam has no such field and adding one would make the wire contract depend on a Host-side plugin's notion of routing. The workspace path already identifies the world, and the same `shadowRoot` value decides filesystem routing and terminal eligibility.

**Stream raw PTY bytes as length-prefixed binary frames.** Rejected: the hub's request channel is NDJSON over HTTP, and framing a second binary protocol inside it buys nothing at these data rates while costing a second parser on both ends.

**Report remote terminal activity from the agent.** Rejected: the agent's PTY does not report shell lifecycle, so `inspectActivity()` returns `unknown` and `inspectForeground()` returns none. Automatic reclamation therefore never treats a remote terminal as idle; retaining one costs terminal quota until the user closes it, which is the conservative direction for a live user shell.

## Consequences

A terminal opened in a mounted workspace runs the member's own shell in their own directory. `ctx.subprocess` keeps local semantics for everything else, so searches inside a mounted workspace still read the shadow copy — [the region design](../../../../shell/design.md) §13.6 records that remaining gap and the identifier work it needs.

The remote agent is no longer dependency-free: it needs `node-pty` 1.2.0-beta.15, whose prebuilt binaries cover macOS, Linux and Windows on arm64 and x64. The provider is opt-in per profile, so a deployment that never enables it keeps an agent that installs nothing.

`createHub` now returns live `agentPort`/`controlPort` getters plus a `ready` promise: `listen` binds asynchronously, so a caller that asked for an ephemeral port (`0`) previously had no way to learn the real one.

Coverage: `shell/tests/pty-roundtrip.spec.ts` runs a real hub, a real agent in a child process, and a real PTY, asserting interactive input and output, the requested working directory, both allowlist refusals, and termination.
