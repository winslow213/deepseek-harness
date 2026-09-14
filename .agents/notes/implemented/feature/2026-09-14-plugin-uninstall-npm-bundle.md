# Agent Note: Plugin uninstall extends to npm-bundle dependencies

Status: implemented

English | [中文](2026-09-14-plugin-uninstall-npm-bundle.zh.md)

## Problem

[The uninstall Remote](2026-09-14-plugin-uninstall-remote.md) deliberately excluded `npm-bundle` installs, reasoning that the form has no per-plugin id to key removal on. In practice an operator who installed a plugin through `npm-bundle` — the form the Web UI's "install an npm package" input actually uses — hits `plugin-install/not-installed` on every uninstall attempt, with no in-product way to remove it; the excluded note's own copy told them to run `pnpm remove` by hand on the host, which most operators cannot do from the Web UI's deployment.

## Decision

**`uninstallPlugin(id)` tries an npm-bundle removal before falling back to the patch-row path.** A new `isNpmBundleDependency(profileDir, packageName)` checks whether `packageName` is an exact key in the profile's `package.json` `dependencies` — read via the same `readProfileManifest()` the install path already uses. A match routes to `uninstallNpmBundle()`, which mirrors `installNpmBundle()`'s own pattern: snapshot the `before` manifest, run `pnpm remove <packageName>`, then call the same `reconcileProfileBundles()` the install path calls, passing `before` so it diffs against the post-removal manifest. `reconcileProfileBundles()` already treats a dependency that disappeared as removed and strips it from `dsh.profile.bundles` — that removal-detection was already there for "a later update drops its `dsh.bundle` declaration" and needed no change to also cover "the package is now gone entirely."

**The dependency check runs before `assertPluginId()`, not after.** `PLUGIN_ID_PATTERN` rejects `/` and `@`, so a scoped npm package name (`@scope/pkg`) can never reach the patch-row path. Checking npm-bundle membership first — a side-effect-free string comparison — lets a scoped or unscoped bundle dependency be removed without ever touching the path-safety rejection, while an id that matches no dependency (including the previous test's `../escape`) falls through unchanged to `assertPluginId()` and its existing `plugin-install/invalid-spec` failure.

**In-box template bundles are protected by never being a real dependency, not by an allowlist.** `@deepseek-ai/dsh-base` and its siblings are listed in `dsh.profile.bundles` at profile-init time but are never written as `package.json` dependencies, so `isNpmBundleDependency()` never matches them and they fall through to the patch-row path, where they have no row and end in `plugin-install/not-installed` — the same outcome as before this change, reached the same way.

## Alternatives considered

**Keep the previous note's rejection of a separate install-time-bundle-name tracker.** Still holds: this change adds no new bookkeeping of "which names npm-bundle installed." It reuses the profile manifest as the single source of truth for what is currently a dependency, exactly as the install path already does, so the earlier rejection of a parallel tracker was not reversed — only the conclusion that npm-bundle removal was infeasible without one.

**Require a distinct Remote parameter (a `form` field) instead of inferring the removal path from `id` alone.** Rejected: every other id already needs no form hint to remove — the id space (patch-row ids are path-safe, npm-bundle names are `package.json` dependency keys) does not overlap, so a single string parameter stays unambiguous and the client's uninstall form needed no new input.

## Consequences

An operator can now uninstall any plugin installed through the Web UI, including npm-bundle, from the same Settings tab section without leaving the browser or touching the host filesystem. The host package's test suite grew by 4 new cases covering npm-bundle removal, the in-box-bundle-name non-match, a `pnpm remove` failure, and the supervised-restart request on that path. The Remote's and both packages' READMEs, and the Settings tab's uninstall copy, all dropped the "npm-bundle is not covered" language this note's predecessor recorded — see [the excluded-scope decision it reverses](2026-09-14-plugin-uninstall-remote.md) for why the exclusion existed and what changed.
