# Agent Note: Terminals confined to mounted device workspaces

Status: implemented

English | [中文](2026-10-28-mount-scoped-terminals.zh.md)

## Problem

A team-shell deployment runs one dsh Web instance per account on a shared server, and a member may additionally pair their own machine, whose roots appear under the hub's shadow tree as mounted workspaces. The sidebar terminal allocates a PTY through `ctx.subprocess.spawnTerminal` on the Host, so in a mounted Session it opened a shell on the server with the shadow directory as its working directory — a shell that looks like the member's machine but is not, and whose `pwd` is a synchronised copy. In the account's own workspace it opened a shell on the server too, which is what the operator did not want offered at all: a Web terminal on a shared server is a shell as the instance account, with nothing to do with the member's own machine.

The confinement cannot live in the terminal UI alone. The Client decides what to render, but the allocation is a Host call, and any Client build could ask for it.

## Decision

`terminal-controller` gains a `mountedWorkspaceRoot` config. When a deployment sets it, a Session may open a terminal only when its workspace is that root or beneath it, i.e. only when the workspace is a paired device's mount. Every other Session reports `{ available: false, reason: 'not-mounted-workspace' }` from `availability`, and `create` refuses with the `terminal/not-mounted-workspace` Remote error, so the Client's rendering is a presentation of the Host decision rather than the decision itself.

The team shell writes the row. `regionRouterPatchYaml` emits a `terminal-controller` config beside the region routers it already provisions, using the same `shadowRoot` value it hands them, so one deployment fact — where the mount tree lives — decides routing, filesystem, and terminal eligibility together. A deployment that never sets it keeps upstream behavior: every workspace is eligible.

The Client guide reads `availability` once per mount and, when it is refused, renders the card as a plain explanation of the confinement with no launch button, no shell menu, and no shortcut chip. A failed availability query is deliberately NOT read as a refusal: an unreadable answer falls back to the launch affordance and lets the Host refuse an allocation it must refuse, because hiding an available terminal behind a transient RPC failure would be worse than showing one the Host rejects.

## Alternatives considered

**Gate only in the Client guide.** Rejected: the Host would still allocate a PTY for any caller that asked without going through the guide, including a stale Client bundle from before the confinement existed. The refusal has to sit where the allocation happens.

**A new `mountedWorkspaces` capability seam.** Rejected for now: one boolean question — is this workspace a mount — would need a Service Definition, a provider in `shell/`, an invariant, and a consumer, all to answer a question the terminal path already has the inputs for (its own configured root and the Session's logged cwd). The seam earns its place when a second consumer asks the same question or when liveness of a specific mount must be resolved; neither holds yet.

**Comparing against the hub's live mount table.** Rejected: it would make terminal eligibility depend on an HTTP call to the hub at allocation time, so a hub that is up but momentarily slow would refuse terminals on a healthy mount. The shadow root is a deployment constant, and a Session's workspace is either inside it or not.

**Refusing terminals for every Session in a team deployment, with no config.** Rejected: the confinement is a property of running one instance per member on a shared server with paired devices, not of the packages. A deployment with no mounts has no reason to lose the terminal, and a hardcoded refusal would make that choice for it.

## Consequences

A member's mounted Session keeps a terminal; a member's server-workspace Session loses one. Because the gate keys on the workspace path rather than on mount liveness, a Session whose mount has gone offline still reports available and then fails during allocation — the terminal reports the provider failure rather than the confinement, which is the honest description of what went wrong.

The PTY still runs on the Host over the shadow directory, not on the paired device. Routing the terminal to the device's own shell needs a PTY over the hub wire protocol, which [the region design](../../../../shell/design.md) defers as "暂缓，非否决" in §13.6; until then this confinement keeps the terminal from claiming to be something it is not.

Coverage: `packages/api/terminal-controller/tests/controller.spec.ts` pins the refusal, the rooted and at-root acceptance, the unconfigured default, and cancellation; `packages/client/ui-sidebar-terminal/tests/terminal-guide.client.spec.tsx` pins the replaced card, the failed-query fallback, and the unmounted rejection.
