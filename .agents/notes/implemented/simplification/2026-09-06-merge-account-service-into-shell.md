# Agent Note: Merge the account service into the team shell

Status: implemented

English | [中文](2026-09-06-merge-account-service-into-shell.zh.md)

## Problem

The team account service (`team/`) and the team shell service plane (`shell/`) duplicated the instance-lifecycle surface. The account service allocated a port, spawned `TEAM_SHELL_COMMAND spawn-user <user> <port>` as a child process, parsed the child's `USER URL: …` stdout line to extract the launch token, then registered it; `shell/src/spawn-user.ts` already contained `superviseUserInstance` for the same per-user instance, and `shell/src/instance-register.ts` made an HTTP round-trip back to the account service to record the same row. Two sibling directories, a second `package.json`, and a fragile stdout contract existed only because the account layer was scoped as a separate delivery in the design record.

## Decision

The account service lives inside the shell as `shell/src/account/`. The shell `package.json` gains `pg` + `ioredis` dependencies — the only shell surface that needs third-party packages; the remote agent (`shell/src/remote/agent.ts`) and the rest of the shell keep their node-builtin-only imports, so a member still runs the agent from a bare checkout with no install. The `team/` directory and its `package.json` are removed.

Instance launch no longer crosses a process boundary. `account/instance-manager.ts` calls `superviseUserInstance(user, port, { onReady })` in-process; the `onReady` hook writes the `dsh_instances` row directly through `InstanceStore` on every generation (the first generation via a deterministic await before the login response, later install-triggered restarts via the hook). The subprocess spawn, the `USER URL: (\S+)` stdout parse, and the `TEAM_SHELL_COMMAND`/`TEAM_SHELL_ARGS`/`TEAM_ACCOUNT_URL`/`DSH_USERS_ROOT`/`DSH_ENTRY_HOST`/`TEAM_INSTANCE_STARTUP_TIMEOUT_MS` forwarding are all deleted. `spawn-user.ts` gains `SuperviseOnReady` (a `superviseUserInstance` option) and an `exited` promise on `SupervisedInstance` so the manager can observe loop end and remove the registration.

Entry points are `dsh-shell account` (service) and `dsh-shell account-cli` (operator CLI), both under `shell/src/bin.ts`. `TEAM_DB_URL` and `TEAM_REDIS_URL` remain required; `DSH_USERS_ROOT` and `DSH_ENTRY_HOST` are read directly by `spawn-user` from the shared `.env`, unchanged.

## Alternatives considered

**Keep two directories and only share `spawn-user.ts` by import.** Rejected because the account layer and the service plane are one product surface; keeping a second `package.json` and a second `tsconfig` preserves the split that created the duplication without buying any isolation the workspace boundary does not already provide.

**Drop third-party dependencies by keeping the HTTP registration round-trip.** Rejected because in-process supervision is strictly simpler: no child-process ownership, no stdout contract, no registration HTTP client, and no startup-timeout env surface to maintain.

**Make `spawn-user` import the account store directly.** Rejected because the account service is the owner of registration and port allocation; `spawn-user.ts` stays the process-free instance runner and takes a registration hook instead of gaining a database dependency.

## Consequences

One directory, one `package.json`, one CLI. The `team/` tree, its lockfile, and its `TEAM_SHELL_COMMAND`/`TEAM_SHELL_ARGS` env plumbing are gone. The shell is no longer uniformly zero-dependency: `npm install` now fetches `pg` and `ioredis` for the account surface, while the member-facing agent path remains node-builtin-only. The `dsh_instances` PID is recorded directly from the supervised child, fixing the null-PID overwrite that the subprocess + self-registration split produced. Shutdown stops the in-process supervisors, which stop their children, so no dsh web instance is orphaned.
