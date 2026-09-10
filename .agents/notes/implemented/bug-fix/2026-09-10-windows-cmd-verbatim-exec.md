# Agent Note: Pass Windows commands to cmd.exe verbatim in the remote agent

Status: implemented

English | [中文](2026-09-10-windows-cmd-verbatim-exec.zh.md)

## Problem

The remote agent executes forwarded commands with `spawn(argv[0], argv.slice(1))`. On Windows, the team shell routes every command through `cmd /c <command>` (see `shellArgvFor` in `executor.ts`), so a model probing a tool often sends something like:

```
dir /b "D:\ohos\ohos_sdk\13\toolchains\bin" 2>&1 | findstr /i "hdc"
```

Node's default argv→command-line quoting (used when `windowsVerbatimArguments` is absent) wraps arguments containing spaces and escapes their inner double quotes with backslashes. `cmd.exe` does **not** treat `\` as an escape character, so the `/c` command line reaches cmd with its quotes mangled. The pipe and the nested quotes then no longer parse as the caller intended, and `findstr` — which reads stdin when it has no file argument — ends up waiting for input that never comes, leaving the command hanging instead of returning.

The earlier report of a bare `findstr /i dsh` hanging is the same class of failure: `findstr` with no file argument and no working pipe reads stdin. This fix addresses the argv-quoting half of that class.

## Decision

`runExec` in `agent.ts` passes `windowsVerbatimArguments: true` when the command binary is `cmd` or `cmd.exe`. This tells Node to hand the argv to `CreateProcess` as-is (joined with spaces) instead of re-quoting it, so `cmd /c` receives the command line exactly as the executor constructed it and parses the pipe and nested quotes itself. The flag only affects `win32`, so the POSIX `bash -c` path is unchanged.

## Alternatives considered

### Why not rewrite the command to avoid `findstr`?

Changing the probing command (e.g. `where hdc`, or `if exist "...\hdc.exe"`) avoids this instance but not the class: models generate arbitrary Windows commands, and any command with pipes or nested quotes hits the same quoting corruption. The executor must execute what it is asked to, so the fix belongs in the agent's spawn.

### Why not switch to `/s` or add `/d`?

`cmd /s /c` only changes how cmd strips a *leading/trailing* quote pair; it does not fix Node's backslash-escaping of the inner quotes. `/d` (disable AutoRun) is an unrelated hygiene improvement, not a fix for this corruption.

### Why not run everything through a temporary `.cmd` script?

Writing the command to a temp script and executing it sidesteps `/c` quoting but adds file lifecycle and cleanup on every exec, and still needs correct quoting when the script path has spaces. Verbatim argv is the minimal, standard fix.

## Consequences

- Windows commands with pipes and nested quotes now execute as cmd parses them, so `dir ... | findstr ...` no longer hangs.
- The guard is scoped to `cmd`/`cmd.exe`; non-cmd binaries keep Node's default quoting, and POSIX is untouched.
- The quoting was necessary but not sufficient: the detached-console half of the same class is fixed in the [detached console note](2026-09-10-windows-detached-console-exec.md).
- The agent is the only place that spawns forwarded commands, so a single change covers every shell and fs-driven exec path.
