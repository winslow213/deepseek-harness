# dsh Team Shell

English | [中文](README.zh.md)

`shell/` is the control plane that runs DeepSeek Harness as a shared team service. It spawns one isolated `dsh` web instance per user, aggregates the instances behind one entry, and bridges shell and filesystem operations out to the code on each user's own machine (Windows included). The directory is deliberately independent: it is not part of the pnpm workspace, it is not registered in the root tsconfig or package.json, and upstream master never creates it, so `git rebase origin/master` never conflicts with this tree. The design record is [design.md](design.md).

## Quick start

Each user gets a private instance with its own DSH_HOME (settings, credentials, sessions, and workspace all live there). Spawn one on a loopback port:

```sh
node --import tsx/esm shell/src/bin.ts spawn-user alice 32001
```

`spawn-user` provisions the user's DSH_HOME under the users root (default `$TMPDIR/dsh-users`, override with `DSH_USERS_ROOT`), boots `dsh --profile web`, and prints the instance's authenticated URL, e.g. `USER URL: http://127.0.0.1:32001/?token=...`. Ctrl-C stops the instance again.

## Remote execution bridge

The bridge serves each user's own code host. The agent on that host dials out to the hub (direction B: a host behind NAT needs no inbound port); the hub listens on an agent port and exposes a loopback HTTP control API, and per-user dsh instances or CLI operators issue exec and file requests over that API. The implementation lives in `shell/src/remote/`: `hub.ts`, `agent.ts`, `client.ts`, `protocol.ts`, `executor.ts` (remote ShellExecutor), `fs-provider.ts` (remote FileSystem), `inject.ts`, `shadow.ts`, `region-router.ts`, `region-shell.ts`, and `mount-sync.ts`.

### Start the hub

Start the hub with one `--user-token user=secret` per user you issue an agent token to:

```sh
node --import tsx/esm shell/src/bin.ts remote hub \
  --agent-port 7101 --control-port 7100 \
  --user-token alice=SECRET_A --user-token bob=SECRET_B
```

`--agent-port` (default 7101, env `DSH_HUB_AGENT_PORT`) is the listener agents dial; `--control-port` (default 7100, env `DSH_SHELL_CONTROL_PORT`) serves the loopback API (`/api/agents`, `/api/mounts`, `/api/pairings`, `/api/exec`, `/api/kill`, `/api/fs-read`, `/api/fs`). The hub heartbeats every agent (15 s), evicts a stale or duplicate connection for the same user or agent id, and closes in-flight requests when an agent channel drops. `--shadow-root DIR` relocates the mount shadow tree (default `/var/lib/dsh-mounts`); `--no-auto-inject` disables the automatic provider injection after a pairing (see below).

### Run an agent on the code host

The agent is the last line of defence: it only spawns `--allow-command` basenames, and every path it serves must resolve under one of its `--root` directories (absolute escapes and `..` climbs are rejected). Start one on the user's Linux machine:

```sh
node --import tsx/esm shell/src/bin.ts remote agent \
  --user alice --token SECRET_A --hub 10.33.2.56:7101 \
  --name alice-linux --root /home/alice/code \
  --allow-command cat --allow-command ls --allow-command git
```

`--root` and `--allow-command` are repeatable, `--name` defaults to `<user>@<hostname>`, and with no `--allow-command` every exec is denied. The daemon reconnects with exponential backoff after the channel drops. Allowlisting a shell (`bash`, or `cmd` on Windows) deliberately grants arbitrary command execution on that platform — the documented way to serve the dsh shell tool.

### Windows code hosts

The agent is platform-independent and runs the same way on a user's Windows machine. Windows has no bash: the shell executor picks the shell from the working directory it forwards (`cmd /c` for `D:\...`-style directories, `bash -c` otherwise), so a Windows agent allowlists `cmd` to serve arbitrary shell commands:

```sh
node --import tsx/esm shell/src/bin.ts remote agent \
  --user alice --token SECRET_A --hub 10.33.2.56:7101 \
  --name alice-win --root D:\work --allow-command cmd
```

### Probe from the server side

Verify connectivity and probe the agent from the server (each of these talks to the loopback control API):

```sh
node --import tsx/esm shell/src/bin.ts remote agents --control-port 7100
node --import tsx/esm shell/src/bin.ts remote mounts --control-port 7100
node --import tsx/esm shell/src/bin.ts remote cat --control-port 7100 alice /home/alice/code/README.md
node --import tsx/esm shell/src/bin.ts remote exec --control-port 7100 alice git -C /home/alice/code status
```

`agents` lists each connected agent (user, remote address, roots, allowed commands); `mounts` lists every served root with the server-side shadow path it maps to (see the region router below); `cat` streams one file through the agent's `fs:read`; `exec` runs an argv through the agent's allowlist.

### Pair a code host with a one-time code

A pairing code lets a new machine join without carrying a long-lived secret. Mint one for a user on the server (this proves you know the user's agent token):

```sh
node --import tsx/esm shell/src/bin.ts remote pair \
  --user alice --secret SECRET_A --control-port 7100
```

The printed UUID is valid for 10 minutes. Claim it on the target host — no `--user`/`--token` needed:

```sh
node --import tsx/esm shell/src/bin.ts remote agent \
  --pair 3d7f0a2e-cd94-4f1b-8b6a-5c2e6f9a1b44 --hub 10.33.2.56:7101 \
  --root /home/alice/code --allow-command git
```

The hub consumes the code, binds the agent to its user, and answers the agent's hello with that user's real token, so later reconnects authenticate with `--user`/`--token` as usual. With auto-inject enabled (the default) the hub then provisions the user's profile with the remote providers; `--no-auto-inject` keeps pairing a pure registration.

### Point a per-user instance at its agent

`remote inject` writes the profile patch that replaces a per-user instance's local providers with remote ones pointing at the user's agent. It copies the provider runtimes into `<profile>/plugins/remote` and writes `cordis.patch.yml` (disabling `bash-sandbox`, `pwsh-sandbox`, and `fs-sandbox`, inserting `remote-shell` and `remote-fs`):

```sh
node --import tsx/esm shell/src/bin.ts remote inject \
  --home /srv/dsh-users/alice --hub http://127.0.0.1:7100 \
  --user alice --cwd /home/alice/code
```

`--home` is the user's DSH_HOME whose `profiles/web` directory is patched; `--cwd` is the remote working directory (must live under the agent `--root`); `--sandbox-mode read-only|workspace-write|danger-full-access` declares the permission intent for that root (default `workspace-write`). Model bash tool calls then reach the agent through the hub with the same resolve/run/start, timeout, and kill semantics as local execution; the agent must allowlist `bash` (POSIX) or `cmd` (Windows) for arbitrary shell commands. Deleting the generated patch file falls back to the local providers.

### Serve local and mounted paths together (region router)

One instance can serve both the server's own authorized directories and every paired agent's mounted roots. Form A gives each agent root a real server-side shadow directory — `<shadow-root>/<user>/<agent>` (a second root adds `/root1`, `/root2`, …) — because dsh's workspace model requires a real, stat-able directory. A workspace bound to a shadow path is a workspace over the remote root: `mount-sync` polls the hub and registers each of this instance's mounts as a workspace (`↗ <dir> (<agent>)`), while the region routers translate every access under the shadow tree back to the owning agent's real path and forward it through the hub.

The routers extend the sandboxed local providers: paths and workdirs outside the shadow tree keep full local semantics; a translated workdir carries the agent platform in its separators, so the executor runs `cmd /c` on a mounted `D:\...` directory and `bash -c` elsewhere. Assembly writes the patch rows `region-fs`, `region-shell`, and `region-mount-sync` (disabling the same local rows as `remote inject`); `injectRegionRouter` in `shell/src/remote/inject.ts` performs the copy and the patch write:

```sh
node --import tsx/esm --input-type=module -e "
import { injectRegionRouter } from './shell/src/remote/inject.ts'
injectRegionRouter({
  runtimeSourceDir: process.cwd() + '/shell/src/remote/',
  hubUrl: 'http://127.0.0.1:7100',
  user: 'alice',
  shadowRoot: '/var/lib/dsh-mounts',
  profileDir: '/srv/dsh-users/alice/profiles/web',
  includeShell: true,
  syncMounts: true,
})
"
```

## Reverse-proxy aggregation

`proxy` aggregates the per-user instances behind a single entry port. `user:port` upstreams are served under `/u/<user>`; an upstream written `@user:port` is the default route whose path is passed through unchanged:

```sh
node --import tsx/esm shell/src/bin.ts proxy 3080 @alice:32001 alice:32002
```

HTTP requests and WebSocket upgrades (the dsh web `/api/remote.mux` channel) are proxied to the matching upstream. Account/login routing on top of the proxy is a later milestone (see design.md §3).

## Development

The standalone shell typechecks without the workspace; the modules that run inside a dsh instance (`executor.ts`, `fs-provider.ts`, and the region-router/mount-sync family) import `@deepseek-ai/*` seams and are checked under the repository's source graph:

```sh
npx tsc -p shell/tsconfig.json --noEmit
npx tsc -p shell/tsconfig.executor.json --noEmit
```

## Design record

[design.md](design.md) records the architecture and milestones: per-user DSH_HOME provisioning, the reverse-proxy aggregation, the remote-bridge design (with the A/B settings question), the region-router shadow-directory form, and what is still unbuilt (TLS for the agent channel, the account layer, lifecycle management, and the pairing web page).
