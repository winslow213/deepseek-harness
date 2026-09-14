# Agent Note: The operator-gated plugin install Remote gains an uninstall path

Status: implemented

English | [中文](2026-09-14-plugin-uninstall-remote.zh.md)

## Problem

[The `pluginInstall` Remote](../architecture/2026-09-05-operator-gated-plugin-install-remote.md) and its [Web Settings tab](2026-09-05-web-settings-plugin-install-tab.md) let an operator install a plugin into the running profile, but nothing removes one: once a `file-dir`, `upload-directory`, or `npm-register` install writes its `plugins/<id>` copy and patch row, undoing it means hand-editing `cordis.patch.yml` and deleting the copy directly on the host filesystem. An operator who installed the wrong plugin, or wants to retire one, has no in-product path back out.

## Decision

**`PluginInstallGateway` gains a second `@Remote('uninstallPlugin')` method, `uninstallPlugin(id: string): PluginUninstallResult`.** It resolves the same profile directory `installPlugin` uses, validates the id with the same path-safe check, and removes the id's marker-delimited row from `cordis.patch.yml`. When the id also owns a `plugins/<id>` directory — a `file-dir` or `upload-directory` install — that directory is deleted too; an `npm-register` id has no such directory, so only the row goes. The call fails with the new `plugin-install/not-installed` RemoteError when no row matches the id, since the patch row is the sole install record for these three forms.

**Scope is deliberately the three patch-row forms only; `npm-bundle` is excluded.** `file-dir`, `upload-directory`, and `npm-register` all key off a stable per-plugin `id` written into the same marker-delimited row shape, so one `removeMarkedBlock()` (the inverse of the existing `upsertMarkedBlock()`) and one `uninstallPluginById()` cover all three. `npm-bundle` has no per-plugin id at all — it integrates through `pnpm add` and the `dsh.profile.bundles` layer list, a package-manager-owned dependency graph with no row this service could safely strip without risking another bundle's transitive dependency. The Remote's doc comment and the Settings tab copy both say to run `pnpm remove` in the profile directory instead.

**`requestRestartIfSupervised()` is reused unchanged and its wording generalized.** The same "write to disk, then ask the supervisor to restart the instance" mechanism that `installPlugin` uses now serves both paths; its log line changed from install-specific "install complete" to "plugin change complete" since it no longer describes only one direction.

**The Settings tab gains a second, independent form in the same `PluginInstallSettingsTab` component.** A plugin-id-only input submits to the newly injected `uninstallPlugin` face, which maps a Remote failure onto a rejecting `Error` carrying the `code` the same way `installPlugin` does. The uninstall section has its own running/success/restarting/error state machine, mirroring the install section's, and its own bilingual copy naming the `npm-bundle` exclusion so an operator who tries it gets an actionable message rather than a silent no-op.

## Alternatives considered

**Give `npm-bundle` an uninstall path by tracking install-time bundle names separately.** Rejected: a `pnpm`-managed dependency graph can share a package across multiple direct/transitive edges, so removing "the bundle this install added" without `pnpm`'s own resolution risks leaving orphaned or breaking shared dependencies. `pnpm remove` already does this safely; duplicating its logic here would be maintaining a second, worse dependency remover.

**Rewrite `cordis.patch.yml` by parsing and re-emitting YAML instead of splicing the marker-delimited region.** Rejected for the same reason `installPlugin`'s writer rejected it: the patch file is a user-edited layer with comments and `!!js` expressions that a parse/re-emit round-trip would not preserve byte-for-byte. `removeMarkedBlock()` reuses the same string-splice approach as `upsertMarkedBlock()`, touching only the id's own delimited block.

**Silently succeed when the id has no patch row.** Rejected: an operator who mistypes an id or targets an already-removed plugin needs to know nothing happened, not receive a false confirmation. `plugin-install/not-installed` names exactly what is wrong, matching the existing failure vocabulary's convention of an actionable message per cause.

## Consequences

An operator can now remove a `file-dir`, `upload-directory`, or `npm-register` install from the Settings tab without leaving the browser, with the same restart-required semantics as install. `npm-bundle` installs remain removable only by hand (`pnpm remove` in the profile directory), a limitation the Remote's failure vocabulary and the tab's copy both state rather than a silent gap. The host package's test suite grew by 8 cases covering removal for each of the three supported forms, preservation of unrelated patch rows, the two failure codes, and the supervised-restart request; the client package's jsdom spec grew by 4 cases covering the disabled-until-filled button, a successful removal, the restart countdown, and the Remote failure mapping. No session event or model-facing surface changed, so no snapshot owns this path.
