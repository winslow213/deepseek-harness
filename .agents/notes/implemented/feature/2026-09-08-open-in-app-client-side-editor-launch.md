# Agent Note: open-in-app client-side editor launch

Status: implemented

English | [中文](2026-09-08-open-in-app-client-side-editor-launch.zh.md)

## Problem

The open-in-app "Open In..." button launches an application by spawning it on the host — the machine running dsh — which is correct when the operator's browser and the host share one desktop. In a remote or SSH deployment the operator's browser lives on another machine, so a host-spawned editor opens (or silently fails to open) on the unattended server, never on the operator's screen. The button then appears installed and returns success while visibly doing nothing.

## Decision

The host reports whether it launched through SSH, and the browser half switches editor launches to the operator's own machine on that signal.

- **Host signal.** `GET /open-in-app/apps` adds a required `clientLaunch` boolean, set from the process environment's `SSH_CONNECTION`/`SSH_TTY` presence (the same heuristic the `web-app` bundle uses to suppress default-browser handoff). An SSH launch means the operator's desktop is not this host.
- **Client-side launch.** When `clientLaunch` is true, the browser half opens editor catalog ids (`vscode`, `vscodeinsiders`, `cursor`, `windsurf`, `zed`) through their URL scheme (`vscode://`, `vscode-insiders://`, `cursor://`, `windsurf://`, `zed://`) by assigning the scheme to `location.href`, which hands it to the operator's OS protocol handler. Applications without a scheme keep the host launch.
- **No workspace folder.** The deep link opens the application alone. The operator's machine and the host have different filesystems, so the host's workspace directory cannot be passed across; a folder that only exists on the host would otherwise resolve to a "not found" window.

## Alternatives considered

**Client-side origin heuristic.** Decide remoteness from whether the page origin is loopback. Rejected: under SSH port-forwarding the page is served on `localhost`, which reads as local and would still host-spawn.

**A config toggle on the browser plugin.** Gate client-side launching behind a `cordis.yml` field. Rejected: browser plugins in this repository do not carry `Config` schemas, and the host already samples the launch environment once, so a config flag would duplicate a fact the host can report directly.

**Fallback after a failed host launch.** Keep host-spawning and switch only when it errors. Rejected: a headless editor spawn usually "succeeds" — the child outlives the watch window and is counted launched — while rendering no window, so there is no failure to fall back from.

## Consequences

Remote deployments gain a working editor button; the launch opens the editor alone rather than the workspace folder, which the operator's filesystem cannot name. The apps-route payload gains a required field, kept in lockstep with the browser half through the shared subpath. The SSH heuristic is duplicated where it already exists in the `web-app` bundle, matching that precedent rather than centralizing a one-line environment check.
