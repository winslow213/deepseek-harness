# Agent Note: Run Windows exec with a proper console in the remote agent

Status: implemented

English | [中文](2026-09-10-windows-detached-console-exec.zh.md)

## Problem

After the argv-quoting fix ([verbatim exec note](2026-09-10-windows-cmd-verbatim-exec.md)), Windows commands still misbehaved: `findstr` hung, and external programs (`hostname`, `where`, `hdc`) wrote `?` or nothing to stdout, while cmd internals (`echo`, `ver`, `dir`) flowed correctly.

The distinguishing clue was the internal-vs-external split. cmd internals run inside cmd.exe itself and write straight to its stdout pipe; external programs are spawned by cmd.exe as console-app children. Those children were failing because the agent spawned cmd.exe with `detached: true`, which on Windows gives cmd a detached console. With that console broken, the console apps cmd spawned could not run or write output normally — `findstr` waited on console I/O instead of returning, and other externals produced `?`/empty stdout.

## Decision

`runExec` in `agent.ts` no longer detaches on Windows:

- `detached: process.platform !== 'win32'` — detach only on POSIX, where it makes the child a process-group leader for `process.kill(-pid)`.
- `windowsHide: process.platform === 'win32'` — hide the console window instead of detaching it.
- `killProcessGroup` terminates the tree with `taskkill /PID <pid> /T /F` on Windows (there is no POSIX-style group to signal), keeping the `process.kill(-pid, 'SIGKILL')` path for POSIX.

This matches the local subprocess provider (`packages/subprocess/subprocess-local/src/spawn.ts`), which is the repository's authoritative Windows spawn pattern.

## Alternatives considered

### Why not keep `detached: true` and only fix quoting?

The quoting fix ([verbatim exec note](2026-09-10-windows-cmd-verbatim-exec.md)) was necessary but not sufficient. It fixed the command line cmd parsed, but the detached console still broke the console apps cmd spawned, so `findstr` hung and externals lost stdout regardless of quoting.

### Why not run externals directly instead of through cmd?

Exec is one argv forwarded through the agent's allowlist; the platform shell (`cmd`/`bash`) is the documented way to serve arbitrary shell commands. Routing each external program around the shell would re-split the command line and re-open the quoting problem the shell already owns.

### Why not `windowsHide` plus `detached: true` together?

`detached: true` is what breaks the child console in the first place; `windowsHide` only hides a window and does not repair a detached console. The two flags are not substitutes.

## Consequences

- External programs spawned by `cmd /c` now return their real stdout, so `dir ... | findstr` returns matches instead of hanging, and `hostname`/`where`/`hdc` output is no longer `?`/empty.
- The tree kill on Windows uses `taskkill /T /F`, which terminates piped children (`findstr`) too; the previous `process.kill(-pid, 'SIGKILL')` was a no-op on Windows.
- POSIX behavior is unchanged: `detached` is still set there, and the group signal path is preserved.
