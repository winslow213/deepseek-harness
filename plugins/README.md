# Plugins

Plugin sources maintained outside the `packages/` tier. A plugin belongs here
when its host-side code must track this harness's APIs: the two must change
together, and a published tarball would drift from the harness it runs on.

Each directory is a pnpm workspace member. Packages here keep their upstream
identity and version; the repository owns only the compatibility edits recorded
in the package's own notes.

## ds-bot

The DS Bot team plugin. Its published 0.2.7 tarball is written against dsh
`0.2.1-rc.5`, so two host-side calls needed adapting for this harness:

- `src/host/tools.js` — `system-prompt/assemble` no longer carries tool
  declarations, and a returned `tools` field is ignored. The waterfall listener
  read the removed field, which threw on every turn before its first step. Tool
  masking now relies on `ctx.tools.restrict()` and the call guard, which the
  removal did not affect.
- `src/host/schedules.js` — `schedule.list()` answers one page
  (`{ items, shown, total, limit, offset }`) instead of a bare array, so
  iterating the result threw `records is not iterable` when a fresh part took
  over the earlier part's active tasks.

Both are recorded in the harness upgrade guides
(`docs/upgrade-guide/v0.2.1-rc.2/conditional-tools/`). The package ships its
browser half as a prebuilt `client.js` generated from `src/client`, which the
tarball does not include; host-side source under `src/host/` is complete.
