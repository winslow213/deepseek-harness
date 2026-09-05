# Agent Note: The Web Settings Plugins section gains an operator-gated install tab

Status: implemented

English | [中文](2026-09-05-web-settings-plugin-install-tab.zh.md)

## Problem

The web GUI reads the plugin inventory but cannot install: Phase A added the operator-gated [`pluginInstall` Remote](../architecture/2026-09-05-operator-gated-plugin-install-remote.md) to the running instance, yet nothing on the web plane calls it, so a GUI operator still leaves the app and opens a shell. The design document's Phase 4 — the Web UI tab — is the missing consumer that makes the Remote reachable to a browser operator.

## Decision

**A new browser package `@deepseek-ai/dsh-client-ui-settings-plugin-install` contributes the Install plugin tab to the Web Settings Plugins section.** The tab offers two install forms — copy a local plugin directory (id plus absolute source path) and install an npm package (a spec forwarded to `pnpm add` as-is) — and submits the chosen one to `ctx.remote.pluginInstall.installPlugin()`. It is wired into the web-app bundle's browser roster beside the read-only inventory tab, and the same `DSH_PLUGIN_INSTALL=true` switch that gates the host Remote also disables the tab's roster row, so a default deploy registers neither the UI nor the Remote.

**Registration is a localized `settings.plugins.tab` contribution.** The plugin injects `slots`, `locale`, `remote`, and `remote.pluginInstall`, and registers an entry with id `plugin-install` at `order: 20` through `ctx.slots.inject()`, so it follows the Plugins section's late tab declaration, redeclaration, locale changes, and teardown without importing the section owner. The dictionary namespace `settings.pluginInstall` is bilingual (zh/en) and the entry label resolves through the shared locale thunk.

**The form owns its whole lifecycle locally.** A submit trims the spec values, locks the form and the submit button while the install runs, then renders the outcome facts — the written profile directory, the installed plugin id or the promoted bundles, and the restart note — or, on refusal, the Remote error message and code verbatim. The injected `installPlugin` face maps `{ ok: false, error: { code, message } }` onto a rejecting `Error` carrying the code, so the component never sees transport or rejection internals.

## Alternatives considered

- **Mount the tab unconditionally and let the Remote gate alone decide.** Rejected: a default deploy would then render an install form whose every submit fails with a missing-service error, contradicting the confirmed gate decision that the install UI and Remote register only when the operator switch is on.
- **Fold the install forms into the inventory tab.** Rejected: the inventory tab is a read-only projection with no mutation path; install carries its own state machine (idle/running/success/failure) and its own Remote, so a separate contribution keeps the read-only tab free of write surfaces.
- **Route refusals through the generic error channel.** Rejected: the Remote errors are already actionable (`pnpm-missing`, `invalid-spec`, `write-failed`); rendering message and code as-is in the tab keeps the copy locale-owned and the failure directly addressable.

## Consequences

The web-app bundle gains an operator-gated client row and a dependency, and `tsconfig.client.json` references the new package. A default deployment is unaffected: without `DSH_PLUGIN_INSTALL=true` neither the tab nor the Remote registers. With the switch on, an operator installs a source directory or an npm bundle into the running profile from Settings and sees the durable outcome facts or an actionable refusal. The package registers nothing model-facing and no session events, so no snapshot owns its output. Two spec files pin the behavior: a jsdom component spec scripts the install face across submit trimming, the running-state lock, success facts, and error rendering, and a browser-plugin spec benches registration, the locale-following label, and the Remote failure mapping.
