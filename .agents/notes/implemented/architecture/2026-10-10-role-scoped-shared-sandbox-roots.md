# Agent Note: Role-scoped shared directories for team-shell accounts

Status: implemented

English | [中文](2026-10-10-role-scoped-shared-sandbox-roots.zh.md)

## Problem

Every team-shell account is confined to its own workspace, and that confinement is implemented by several independent layers. The team needed two directories that outlive a single account: one the operators share, one every member shares. Making one visible turned out to require three separate gates to open, and only two of them were known.

**The write gate** is `writableRoots()` in [`packages/sandbox/sandbox/src/roots.ts`](../../../../packages/sandbox/sandbox/src/roots.ts), which returns the workspace root plus `/tmp` and `tmpdir()`. `sandbox-policy`'s `workspaceRoot` feeds it, and every profile dialect derives its own expression from the result.

**The read shield** is `readShield()` in the same module. It denies the shared users root and re-exposes one account's own home, because the account homes are siblings under one directory: a confined shell could otherwise `cat` another account's `.credentials.yaml`. It is not a permission boundary at the filesystem level — every instance on this host runs as the same UID, so the shield is the only thing separating accounts. A directory the sandbox may write is therefore also denied read access until it is explicitly re-exposed.

**The filesystem gate** is a team-shell addition with no counterpart in the sandbox packages. `packages/fs/fs-sandbox` overrides only `writeText` and `editText`; its `checkedTarget` has no read-side check at all. Team-shell accounts instead get their `ctx.fs` from `region-router`, which enforces its own read boundary against `workspaceRoot` alone — so `readText`, `stat`, `listDir`, `readBytes`, and `streamText` all refuse a path the write gate permits. Opening only the first two gates yields a directory an agent can write into and then cannot `stat`, which is worse than not offering it.

`dsh_users.role` already existed, with `operator` and `member` values in the type. Nothing read it: every query in the account service passed it through, and the KB's `sync_from_dsh_users` hardcodes its own role column. All 43 rows were `member`.

## Decision

**A deployment-level `TEAM_SHARED_ROOTS` mapping assigns directories to roles, and provisioning resolves it against the account's role into three environment facts the sandbox and `ctx.fs` consume.**

`TEAM_SHARED_ROOTS` is a JSON array of `{ path, roles?, write? }`. `path` accepts a `<usersRoot>` placeholder so a deployment can express directory layout without repeating its own absolute root; an entry with no `roles` applies to every role and an entry with no `write` grants write access, so `write: false` is how a deployment states an intentionally read-only directory. `parseSharedRoots` ([`shell/src/shared-roots.ts`](../../../../shell/src/shared-roots.ts)) is deliberately tolerant: a malformed mapping yields no shared roots and a logged reason rather than a failed spawn, because the alternative is that one bad environment variable makes every account on the host unbootable.

**Three environment variables carry the resolved result to the child**, all written by `teamChildEnv`:

- `DSH_RW_ROOTS` — the shared directories the sandbox may write.
- `DSH_READ_ALLOWED_ROOTS` — the account's own home plus every granted directory. A writable grant must also be readable, so this list is a superset of the first.
- `TEAM_SHARED_ROOTS` is passed through unchanged so a child can re-resolve it.

`writeTeamSandboxPatch` emits them into the account's `cordis.patch.yml` beside `readDeniedRoots`, which is what keeps a granted directory visible through the read shield. `readDeniedRoots` and `readAllowedRoots` must stay single-quoted YAML scalars: an unquoted `!!js [` value parses as a flow sequence, and the trailing `.filter(...)` then fails the whole patch, which stops the account from booting rather than merely dropping the shield.

**`rwRoots` joins `SandboxExecutionPolicy`**, and `effectiveRwRoots()` filters it before any dialect sees it. An entry is discarded when it is not absolute, when it is `/`, or when it is a mode-owned path (`workspaceRoot`, `/tmp`, `tmpdir()`) or an ancestor of one. The last rule is not tidiness: the bwrap dialect appends `--bind` arguments to the same section that carries `--tmpfs`, and bwrap applies the last matching mount, so binding an ancestor of a mode-owned path would silently replace that path's handling instead of adding to it.

**Each dialect takes the extra roots where its own expression needs them**, rather than all three consuming one helper:

| Dialect | Change |
|---|---|
| bwrap | `--bind` appended to the mode section; reads already come from `--ro-bind / /` |
| landlock | appended to both `readWrite` and `readOnly` |
| seatbelt, fs-sandbox, windows-acl | none — they already consume `writableRoots()`/`readShield()` |

The landlock rule is the non-obvious one. With a read shield configured, its `readOnly` list is a strict allow-list, so a granted directory that is not named there stays unreadable even though `readWrite` permits it. `readWrite` is not collapsed onto `writableRoots()`, because that helper also returns `tmpdir()`, and widening the write surface as a side effect of a directory grant is an unrelated behavior change.

**`region-router` grows a `readableRoots` config field** for the third gate, wired through `InjectRegionRouterOptions` and `regionRouterPatchYaml` so a spawned account's router gets it from the same provisioning pass. `allowsLocalRead` replaces the two former assertion helpers, and the shadow-path early return stays ahead of the boundary check.

**`disturbsShadowTree()` drops a grant that would expose the shadow root.** The mount shadow tree is not sandbox-confined: it is written by a third-party plugin through `node:fs`, and it is what the dashboard walks to list a member's mounted device. Today it is hidden from other accounts by accident — `--tmpfs /tmp` happens to erase the whole of `/tmp`, and the shadow root lives at `/tmp/dsh-shadow` while `readDeniedRoots` does not list `/tmp`. A grant covering `/tmp` or any ancestor of the shadow root would revoke that isolation for every account at once.

**`role` is read from the account service.** `GET /api/accounts/<user>` returns only the role, behind the existing `authorized()` check, and `fetchAccountRole` reads it on the CLI spawn path, which previously had no account lookup. A failed lookup is logged and the spawn continues with no shared roots: that path is also how an account is recovered when the account service is down, and refusing to start would turn one broken service into a host-wide outage.

## Alternatives considered

**A member-role table for shared directories.** A `shared_roots` table plus a grant table would let an operator assign directories per account without editing an environment variable. Rejected for now: the role axis is the whole requirement, both directories are deployment-wide constants, and a grant table needs its own read path, cache invalidation, and migration before it earns anything. The seam is left open — the resolution step takes a role and a mapping, so a future provider can compute either from a database.

**One directory shared by every role.** Rejected: it collapses the distinction the request was about. An operator-only directory is what keeps runbooks and credentials out of the member-visible one, and a single world-writable shared root would have to be redesigned the moment anything operator-specific landed in it.

**Unix groups, setgid, and a dedicated shared group.** Rejected as inoperative here: every instance on the host runs as the same UID, so no mode bit or group membership distinguishes them. The account homes are `700` and provide no isolation for the same reason — the sandbox read shield is what actually separates accounts, which is why a shared directory needs the shield's cooperation rather than a `chmod`.

**Putting the shared directories under the users root and relying on `<usersRoot>` resolution alone.** Rejected: `readDeniedRoots` covers the entire users root, and the shadow-tree guard exists because a re-exposed directory inside a denied tree is exactly the shape that can also swallow the shadow root. Keeping the directories outside the homes and re-exposing them by name keeps the two lists independent.

**Letting the sandbox consume a single `rwRoots` for both read and write.** Rejected: it conflates "may be written" with "must be readable". A grant could reasonably be readable without being writable, and a single field would make that inexpressible.

**Failing a spawn when the role lookup fails.** Rejected: see the decision above. A degraded account with no shared directory is usable; an account that will not start is not.

## Consequences

An account now sees one common directory and, when its role is `operator`, an administrator one, and both are reachable from the shell and from the filesystem tools alike. The three gates are exercised together: `packages/sandbox/sandbox/tests/roots.spec.ts` covers the discard rules and the shadow guard, `packages/sandbox/sandbox-local/tests/local.spec.ts` covers the bwrap and landlock argument lists, `shell/tests/region-router.spec.ts` covers the read boundary, and `shell/tests/shared-roots.spec.ts` and `shell/tests/spawn-user-sandbox.spec.ts` cover the mapping parse and the per-role environment a spawn hands the child.

The costs are a second place that decides what a sandbox may touch, and a mapping whose failure mode is silence: a mistyped `path` yields no shared roots and a log line, not an error. The guard against that is that the resolved lists are visible in each account's `cordis.patch.yml`, so an operator can read what a role actually produced.

Shared roots exist on the server only. `region-shell` routes by workdir, and an account whose workdir is a mounted shadow path has its commands forwarded to the member's own machine, where none of these directories exist. The filesystem tools still reach them through the local branch, so an agent can read and write a shared file while a shell command in the same session cannot see it. Nothing in this change resolves that split.

Grants are also validated at provisioning, not at use: the deployment rule is that a shared root must not be an ancestor of the shadow root, and the check runs where the mapping is parsed. A deployment that later moves its shadow root under a directory it has already granted needs a new provisioning pass, and the guard follows whichever shadow root the environment names.
