# Agent Note: Mounted-workspace prompt declaration

Status: implemented

English | [中文](2026-09-10-mounted-workspace-prompt-declaration.zh.md)

## Problem

In the team shell, a user's working directory is a **mounted shadow directory** that mirrors a remote host's root. The region routers (`region-fs`, `region-shell`) rewrite accesses under the shadow tree back to the owning agent, and `mount-sync` registers each shadow directory as a workspace. But nothing in the system prompt told the model this. The only working-directory fact the model saw was `personaSuffix: Your working directory is {{cwd}}`, and `{{cwd}}` resolves to `session.header.cwd` — the shadow path like `/tmp/dsh-shadow/winslow/pairing@WH-D-010484A`, which looks like an ordinary server path. The model therefore searched the server's own home and workspace directories for the user's code instead of the mounted host, and did not know which host to run commands against.

The declaration could not be a static sentence, because the mount path is never fixed: a user pairs zero, one, or many agents, each with its own shadow directory and remote root.

## Decision

A new injected plugin, `shell/src/remote/mount-declare.ts`, registers a system-prompt section that is derived at assembly time. It polls the hub mount table (`/api/mounts`, the same source the routers read) into an in-memory cache, and the section's text function resolves the current `context.agent.session.header.cwd` against that cache with the existing `isShadowPath` / `translateShadowPath` helpers. The text:

- is empty when the cwd is absent, outside the shadow tree, or under a mount this instance's user does not own — so local sessions get no added prose;
- names the single mount the cwd maps to (shadow path → remote root → agent id);
- enumerates every mount this user owns, so the declaration stays correct for any mount count without hardcoding a path, agent, or number;
- names the instance's DSH_HOME as the server-side local user space, so the model can locate local data — saved A2UI tools live under `<home>/a2ui-tools`, not on the mounted host.

The pure rendering lives in `shell/src/remote/mount-declare-render.ts` so the standalone `node:test` runner (which cannot resolve `@deepseek-ai/*`) can exercise it; the plugin file only wires the cache, the poll, and the `ctx.systemPrompt.section` registration. The section sits at a new central order slot `MOUNTED_WORKSPACE: 10150` in `SECTION_ORDERS` (between `WEB_SURFACE` and `DEPLOYMENT_PERSONA_SUFFIX`). The profile patch emitted by `injectRegionRouter` inserts a `region-mount-declare` row when `declareMounts` is set, and `spawn-user` sets `declareMounts: true` alongside the existing `syncMounts`/`includeShell`; the row also carries `home` (`userHome(user)`), which the declaration names as the local user space.

## Alternatives considered

### Why not a static `personaSuffix` override?

A fixed sentence like "your working directory is a mounted directory" would be wrong for local sessions (which also run through the same profile) and could not name which mount, host, or agent the cwd resolves to. It also cannot adapt when the user adds or removes a mount.

### Why not write the declaration into the shadow directory as an agent-instructions file?

The shadow directory is created lazily and removed when the mount unloads, so a file there would not survive mount churn and would need its own lifecycle management. It also could not know about the user's *other* mounts.

### Why not a new section order per mount?

Section placement is a fixed, centrally allocated list, not per-data. One order slot shared by every mounted session keeps the assembly stable while the content stays dynamic.

## Consequences

- Mounted sessions now receive an explicit, always-accurate declaration of the cwd→host mapping and the full mount list; local sessions are unchanged.
- The declaration depends on a hub poll (default 30s, same cadence as `mount-sync`). A transient hub blip keeps the last known mounts rather than blanking the prose the model is about to read.
- The new `MOUNTED_WORKSPACE` order is a shipped-package surface change; the cordis catalog already derives `PromptSectionOrderName` from `SECTION_ORDERS`, so no catalog regeneration was needed.
