---
description: "Operator-gated plugin install tab in Web Settings for the dsh web client: copy a local plugin directory or install an npm package into the running profile directory, with progress, outcome facts, and restart guidance."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-plugin-install

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-settings-plugin-install` contributes the **Install plugin** tab to the Web Settings Plugins section. The tab offers four install forms — copying a local plugin directory into the profile, running `pnpm add` on an npm package, uploading a picked directory, or registering an installed npm plugin's startup row — and submits the chosen one to `ctx.remote.pluginInstall.installPlugin()`. While an install runs the form is locked and the submit button shows progress; on success the tab reports the written profile directory plus the installed plugin id or the promoted bundles, and on failure it shows the Remote error message and code. The change takes effect only after the Web instance restarts, which the tab states in both states. The tab registers only when the operator gate `DSH_PLUGIN_INSTALL=true` is set, matching the Host-side install Remote.

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

Open the Plugins section in Settings and select the **Install plugin** tab. The tab reads no Remote during plugin activation — installing calls `ctx.remote.pluginInstall.installPlugin()` only when you submit the form.

### Choosing an install form

The **Copy a local directory** form takes a plugin id and the absolute path of a directory containing an `index.ts` entry; it copies the directory under the profile's `plugins/<id>/` and registers the startup row. The **Install an npm package** form takes a package spec forwarded to `pnpm add` as-is; packages declaring `dsh.bundle` are promoted into the profile's bundle list. The **Register an installed npm plugin** form takes a plugin id, a Loader entry specifier that resolves from the profile's installed dependencies, and an optional JSON config object written into the startup row's `config` key. Every form requires its fields before the submit button enables, and trims submitted values.

### Reading the outcome

A successful install reports the profile directory the plugin was written into, the installed plugin id for a directory copy, or the promoted bundles for an npm install, followed by the restart note. A refused install reports the Remote error message and its error code.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tab is a browser-only form over the Host-owned `pluginInstall` Remote; it holds all its view state locally and never reads the Loader.

### Registration

The browser plugin registers one localized `settings.plugins.tab` contribution with id `plugin-install` at `order: 20`, next to the read-only inventory tab. Registration uses `ctx.slots.inject()`, so it follows late tab declaration, redeclaration, locale changes, and teardown without importing the section owner.

### Remote failure mapping

The injected `installPlugin` face maps a refused Remote result (`{ ok: false, error: { code, message } }`) onto a rejecting `Error` that carries the code; the component renders the message and code as-is, so transport and rejection details never leak into the copy.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings section, the remote call, and the Host-side service.

- [ui-settings-plugins](../ui-settings-plugins/README.md) — the Plugins section this tab registers into.
- [ui-settings-plugin-inventory](../ui-settings-plugin-inventory/README.md) — the read-only Plugin list tab that sits beside this one.
- [ui-settings](../ui-settings/README.md) — the domain base declaring `settings.plugins.tab`.
- [api-remotes](../../api/remotes/README.md) — the Remote BFF surface behind `pluginInstall.installPlugin()`.
- [plugin-install](../../host/plugin-install/README.md) — the Host-side install service this tab drives.

-----

<a id="model-experience"></a>
## Model Experience

None, as the browser-side tab only renders the install form and submits to the `pluginInstall` Remote; it registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the freshness and restart coupling of the install flow; they are current package constraints.

- **Effect after restart only** — a successful install reports that the writes landed, not that the plugin is live; the running Web instance activates new bundles only on restart.
- **No auto-refresh after restart** — the tab does not watch the process or poll the inventory; the operator reloads the page after restarting the instance.
- **Self-first target only** — the tab installs into the running instance's own profile directory; picking another registered user's instance is deliberate follow-up work.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No invariant companion is published because this package owns no diverging runtime observations; it only renders a form over the Host install Remote.
