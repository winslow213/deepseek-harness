---
description: "Operator-gated Remote for installing and uninstalling external plugins in the running dsh profile from the Web UI: the pluginInstall service with its install Remote (file-dir copy, npm-bundle, and npm-register forms) and a single uninstallPlugin Remote that covers every form."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-plugin-install

English | [中文](README.zh.md)

## Summary

The web instance can install external plugins into its own profile directory over the Remote namespace. `pluginInstall/installPlugin` supports three forms: `file-dir` copies a source directory under `plugins/<id>` and registers a patch row; `npm-bundle` runs `pnpm add` and promotes the bundle into `dsh.profile.bundles`; `npm-register` writes a startup row for an already-installed npm plugin. `pluginInstall/uninstallPlugin` covers all three through one reconcile: an npm-bundle id runs `pnpm remove` and drops the bundles entry, any other id (`file-dir`, `upload-directory`, `npm-register`) removes its patch row and, for a copy-based install, its `plugins/<id>` directory. The service is operator-gated (`enabled: true`, `DSH_PLUGIN_INSTALL=true`); clients consume it through [`api-remotes`](../../api/remotes/README.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Call `pluginInstall/installPlugin` from an operator-facing client when the running profile must gain a plugin. The Remote is the only entry point: the service is Remote-only and deliberately declares no same-process Cordis `Context` merge.

### The install forms

The request is discriminated by `form`:

- **`file-dir`** — copy an absolute local source directory into `plugins/<id>` inside the profile, write a minimal `{"type": "module"}` manifest when the copy ships none, and insert (or replace) a marker-delimited `- insert:` row in the profile's `cordis.patch.yml`. The plugin id must be a single path-safe segment (`A-Za-z0-9._-`), so an id can never escape the `plugins/` directory. A reinstall replaces the prior copy wholesale and the prior patch row in place.
- **`npm-bundle`** — run `pnpm add <spec>` in the profile directory (initializing a profile manifest first when none exists) and then reconcile the profile's layer stack, promoting any newly added bundle into `dsh.profile.bundles` so the bundle layer list reflects the install. A pnpm refusal of a build script (`ERR_PNPM_IGNORED_BUILDS`) approves the flagged packages in `pnpm-workspace.yaml` and retries once; a placeholder pnpm left from an earlier refusal is approved and rebuilt so native bindings exist before the profile restart.
- **`npm-register`** — write a startup row for an installed Cordis npm plugin that has no `dsh.bundle` (so the `npm-bundle` reconcile never promoted it): the request names a plugin id and a Loader entry specifier (`dsh-some-plugin` or `@scope/pkg/lib/index.js`), optionally with a JSON config object rendered into the row's `config` key. The specifier must resolve from the profile's installed dependencies, so a typo or an uninstalled package fails here with `plugin-install/unresolved-package` instead of at the next restart.

### Which profile receives the install

The target profile is the explicit `profileDir` config override when a deployment supplies one; otherwise the service self-locates the running instance's profile from the bootstrap `include` entry's `config.path` — the file URL of the profile's `cordis.yml` — and uses its directory. When neither exists, the call fails with `plugin-install/unknown-profile`.

### Uninstalling a plugin

Call `pluginInstall/uninstallPlugin` with the id used at install time (a patch-row id) or the npm package name (for an npm-bundle install). The id is first checked against the profile's `package.json` dependencies: a match runs `pnpm remove <name>` and reconciles the profile's layer stack, the same way `npm-bundle` install promotes a new dependency — this drops the removed name from `dsh.profile.bundles` too. An id that is not a real dependency (in-box template bundles like `@deepseek-ai/dsh-base` are listed in `dsh.profile.bundles` but are never dependency entries, so they never match here) falls back to the patch-row removal: it removes the id-delimited patch row from `cordis.patch.yml` and, when the id also has a `plugins/<id>` directory (a `file-dir` or `upload-directory` install), deletes that directory too; an `npm-register` id has no such directory to remove. The call fails with `plugin-install/not-installed` when neither an npm-bundle dependency nor a patch row matches the id.

### Failure vocabulary

Install failures raise `RemoteError` with a stable code: `plugin-install/unknown-profile` when no profile can be located, `plugin-install/invalid-spec` for an unsafe id, unusable source path, or malformed/non-object JSON config, `plugin-install/unresolved-package` when a registered specifier is not an installed dependency, `plugin-install/pnpm-missing` when `pnpm` is not on PATH, `plugin-install/pnpm-failed` when `pnpm add` or `pnpm remove` exits non-zero, and `plugin-install/write-failed` when a copy, manifest, patch, or reconcile write fails. Uninstall additionally raises `plugin-install/not-installed` when the given id matches neither an npm-bundle dependency nor a patch row.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The gateway keeps the profile on disk as the single install truth: `file-dir` installs write the copy and the patch row directly, `npm-register` installs write the startup row directly, and `npm-bundle` installs delegate package resolution to `pnpm` so the healed profile `node_modules` — which already links in-box and added bundles — is the resolution root. The `npm-register` form verifies its specifier through the same Node resolution the Loader will use at startup (`createRequire` from the profile manifest), failing loud instead of surfacing a startup error after a restart. Bundle bookkeeping is owned by `dsh-app-boot`: `initProfile` seeds a missing profile manifest, `readProfileManifest` snapshots the layer state before the install, and `reconcileProfileBundles` promotes newly added bundles into the profile layer list. The service performs no npm resolution of its own.

### Patch-row idempotence

The patch row is delimited by `# >>> dsh-plugin-install <id>` and `# <<< dsh-plugin-install <id>` comment markers. Insertion replaces the block between matching markers when present, so a reinstall never duplicates rows; every other row, comment, and `!!js` expression in the patch file is preserved byte-for-byte.

### The operator gate

The gate is two-layered. The class constructor throws unless `enabled: true`, so a misconfigured mount fails loud at load. Independently, the web-app composition disables the row unless `DSH_PLUGIN_INSTALL` is exactly `true`, so even a package-level default cannot expose the namespace in a default deploy.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `PluginInstallGateway`: the `pluginInstall` Remote service, profile self-location, the install forms, the uninstall path, and the patch-row reader/writer |
| [`src/types.ts`](src/types.ts) | Public payload types: `Config`, `PluginInstallSpec`, `PluginInstallResult`, and the `RemoteErrorDetailsMap` extension |
| — | No runtime invariant companion is published; installs are exercised against a real temporary profile in `tests/install.spec.ts`. |

Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the install contract is not enough: how the Remote reaches clients, then the profile and bundle machinery the install forms build on.

- [Remote assembly](../../api/remotes/README.md) — how clients consume `pluginInstall/installPlugin` without importing the Host implementation.
- [App boot](../../boot/app-boot/README.md) — `initProfile`, `readProfileManifest`, and `reconcileProfileBundles`, the profile-layer bookkeeping behind the install forms.
- [Plugin install design](../../../shell/plugin-install-design.md) — the design document this package implements.

-----

<a id="model-experience"></a>
## Model Experience

None, as the operator-gated install Remote registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what an operator-gated install cannot do today. They are current package constraints, not a task backlog.

- **Requires pnpm on the host** — the `npm-bundle` form shells out to `pnpm`; a host without it fails with `plugin-install/pnpm-missing`, and installs never bundle their own package manager.
- **No remote fetch for file-dir** — the `file-dir` form copies a local directory only; fetching a plugin from a registry or URL is `npm-bundle`'s job.
- **No hot reload** — installs mutate the profile on disk and the patch layer; the running Loader does not re-read them, so effects apply on the next profile load.
- **npm-bundle uninstall keys on the `package.json` dependency name, not the original install spec** — a git-hosted or aliased install spec (`pnpm add npm:alias@spec` or a git URL) resolves to a different `dependencies` key than what was typed at install time; use the name from the install response's `bundlesAdded` or from `dsh.profile.bundles` to uninstall it.
- **Default deploy never mounts it** — the namespace is off unless the operator explicitly enables the row and sets `DSH_PLUGIN_INSTALL=true`; a deployment that forgets the env switch gets no install surface rather than a silently half-open one.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
