# Agent Note: Provisioning owns the mandatory plugin set and the IM workspace default

Status: implemented

English | [中文](2026-09-17-provisioning-owns-plugins-and-im-workspace.zh.md)

## Problem

Two things every team-shell account needs were, in different ways, left to the member.

**A required plugin set.** `@xmanrui/dsh-im` and `@nanmicoder/dsh-agent-teams` are what make an account reachable from IM and able to run a team workflow. An operator could install them per account by hand, and a member could add them through the ordinary plugin flow, but nothing made a new account start with them or an existing one catch up after the set changed. An account missing them is not degraded, it is invisible: no bot, no workflow.

**The IM workspace default.** `@xmanrui/dsh-im` resolves each channel's default workspace as `resolve(config.workspace ?? process.cwd())`, and every team-shell instance is spawned with `cwd` set to the shared repository root. A bot whose mapping had not been recorded therefore claimed the entire repository as its workspace the first time it connected. This was reported from Feishu more than once, on different accounts, and each time the correction was a hand-edit of one account's `workspaces.json` — which fixed the account in front of the operator and left the next one to fail identically.

## Decision

**`provisionUserHome` installs the pinned plugin set through the same path a member would use, and writes the IM workspace default into both the config and the data.**

`ensureMandatoryBundles` installs each spec in `MANDATORY_BUNDLE_SPECS` by invoking `dsh plugin --profile web add` against the account's home, rather than editing the profile manifest directly. The install therefore produces a `dependencies` entry and a `dsh.profile.bundles` row indistinguishable from a member's own choice, and it stays correct if the plugin flow's bookkeeping changes. It skips the install entirely when every pinned spec already matches, which is the case on every restart after the first, and it logs a failed install and leaves it for the next restart to retry rather than blocking a member's login on a registry hiccup.

**`ensureImWorkspaceDefault` rewrites recorded mappings that point at the shared repository root, and `ensureImWorkspacePatch` stops new ones from being recorded.**

The two are not redundant. The data rewrite repairs bots that recorded the wrong path before the config existed; the config decides what a bot records from now on, so a bot registered mid-session gets the right default immediately, with no file rewrite and no restart. `ensureImWorkspacePatch` upserts a shell-owned block into the account's home-level `cordis.patch.yml` setting `workspace` on all eleven `@xmanrui/dsh-im` channels whose runtime reads `config.workspace ?? process.cwd()` — `feishu`, `weixin`, `dingtalk`, `wecom`, `wecomApp` (camelCase, unlike its siblings), `qq`, `slack`, `telegram`, `discord`, `whatsapp`, and `imessage`; the last three inherit the shared controller's behavior rather than reading it themselves. It writes only when the plugin is actually installed, because an id-targeted patch naming an absent row is a hard boot failure.

Both run on every `provisionUserHome` call, so an existing account self-heals on its next restart and a new account is correct from creation.

## Alternatives considered

**Editing the profile's `package.json` and bundles list directly.** Rejected: it would produce bookkeeping that only *looks* like an installed plugin. Going through `dsh plugin add` means the reconciler's own view of installed state stays the authority, so a future change to how plugins are recorded does not silently diverge from what provisioning wrote.

**Writing the workspace into the profile-level `cordis.patch.yml`.** Rejected for the same reason [the wiki's injection](../feature/2026-09-16-team-shell-user-wiki.md) uses the home-level file: the profile-level patch is fully overwritten by `injectRegionRouter` on every provisioning call, so a block written there would be wiped on the next refresh. The home-level patch already has an established upsert convention.

**Fixing only the recorded mappings, in a one-off sweep across existing accounts.** Rejected because it was tried: it fixes the accounts in front of the operator and leaves the next bot to record the same wrong path. Correcting the default at the config is what makes the fix hold for a bot that does not exist yet.

**Fixing only the config.** Rejected: a bot that recorded the repository root before the config existed keeps that mapping, and `workspaces.json` is what the runtime reads.

**Setting the workspace from an environment variable at spawn time.** Rejected: the plugin's precedence is `config.workspace` over `process.cwd()`, so an environment-level answer would be the wrong lever — and the channel config is where a member's own override would have to be read from anyway.

## Consequences

A new account now starts with the team's plugin set already installed and every IM channel pinned to its own workspace, and an existing account converges on its next restart. On this deployment the sweep after the change found no remaining wrong mappings, and the config block is verified to merge rather than replace the row it targets (`--dump-config` shows the bundle's `name` surviving alongside the added `config`).

The costs are a `pnpm add` on an account's first provisioning (skipped afterwards) and a provisioning step that depends on the package registry being reachable, which is why a failed install is logged and deferred rather than fatal. The config list is eleven hand-written channel names, so a channel added to the plugin later will not be covered until this list is extended; the alternative is enumerating the plugin's channels at runtime, which the plugin does not expose.

Test coverage is `shell/tests/spawn-user-mandatory-bundles.spec.ts` (the skip-when-current path, and that a failed install does not throw) and `shell/tests/spawn-user-im-workspace.spec.ts` (the recorded-mapping rewrite, the eleven-channel patch, the absent-plugin guard, and idempotence).
