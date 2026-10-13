# Agent Note: Cross-face workspace subpath aliases in the tsconfig paths map

Status: implemented

English | [中文](2026-10-12-cross-face-workspace-subpath-aliases.zh.md)

## Problem

`tsconfig.base.json` is the single `paths` facade every program resolves workspace imports through: both compiler aggregates, the vitest configs, and `tsx`-launched scripts. Two writers fill it. A generated region between the `BEGIN generated package aliases` and `END generated package aliases` markers comes from `scripts/gen-tsconfig-paths.ts`; everything above that region is hand-written.

The generator maps bare package names only. `collectPackageNames` reads the workspace package list, and `mappedSpecifiers` recognizes keys of the form `"@deepseek-ai/dsh-<name>"`, so a subpath alias such as `…/types` or `…/client` is never emitted and never checked. `uncoveredPackages` reports a package no alias maps, but it compares bare names, so an unregistered subpath passes every gate.

An unregistered subpath still resolves — through the workspace symlink and the package's own `exports` map — but to built `lib/` output. `packages/web/tool-a2ui-data` declares `"./types": { "types": "./lib/types/types.d.ts" }`, so a consumer reaching that specifier without an alias leaves the source plane for the artifact plane, which is what the aliases exist to prevent.

The failure also does not look like a missing module. `packages/api/remotes/src/client/index.ts` re-exports the A2UI data types across the Host/Client face split, and the Client aggregate analyzes that re-export. With the subpath resolving to a declaration Typert cannot read as source, the face analyzer reaches `getSymbolAtLocation` with no source file and throws inside `getSymbolLinks`: `Cannot read properties of undefined (reading 'flags')`, naming neither the package nor the subpath.

## Decision

**Every subpath a program resolves is registered by hand in the block above the generated region, with the alias pointing at the declaring `src` file.**

`"@deepseek-ai/dsh-tool-a2ui-data/types": ["./packages/web/tool-a2ui-data/src/types.ts"]` joins the entries already there. That block carries the other hand-written reasons: a package whose directory name does not match its npm name (`sdk/`, `util/`), and a browser half that needs source-mode resolution for a dynamic import.

A generated Typert Remote declaration is deliberately absent from that set. It is consumed as built output on both faces, so mapping one to source would replace the generated default export the Client loads with a module that has none.

## Alternatives considered

**Derive subpath aliases from each package's `exports` map.** Rejected: every `exports` target is a `lib/` path, so generating from it would encode the artifact plane the facade exists to avoid, and it would also pull in the generated `/remote` and `/typert` entries that must stay on built output.

**Make the generator fail on an unregistered subpath.** Rejected: the generator can only see specifiers it already emits, while a subpath is discovered solely from a consumer's import. Keeping `uncoveredPackages` bare-name-scoped leaves the gate's rule checkable and the exceptions in the hand-written block.

**Resolve every subpath to source and drop the exceptions.** Rejected: the Remote and Typert subpaths have no source-plane equivalent, because their content is generated during the Host build.

## Consequences

A package that adds a subpath another package imports gains one hand-written line. Forgetting it produces a Typert crash that names no file, and `verify-tsconfig-paths` does not cover the hand-written block, so nothing turns that omission into a gate failure.

The Client aggregate now resolves the A2UI data types to their declaring source file rather than a build artifact.
