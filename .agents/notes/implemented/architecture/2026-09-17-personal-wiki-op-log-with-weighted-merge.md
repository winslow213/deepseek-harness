# Agent Note: The personal wiki records an append-only op log merged by a weighted gate

Status: implemented

English | [中文](2026-09-17-personal-wiki-op-log-with-weighted-merge.zh.md)

## Problem

[The per-account wiki](../feature/2026-09-16-team-shell-user-wiki.md) writes L1 (identity) and L2 (preferences) by overwriting the whole layer file. On this deployment one account routinely runs several sessions at once — the Web UI in a browser, a Feishu bot, a WeChat bot — all against one instance. Two of them calling `wiki_note` on the same layer is ordinary, not exotic, and a whole-file overwrite makes the second write erase the first writer's content outright.

[The conflict guard](../bug-fix/2026-09-16-wiki-whole-file-write-conflict-guard.md) stopped the silent loss by refusing the second write, which fixed the corruption and created a different one: the second session's content is simply dropped, and the model's only recourse is to retry with text it has to reconstruct itself. A refusal is not a merge.

The layer file is also the only copy. Anything that rewrites it — a rotation, an outside edit, a half-finished write — destroys history with no way to tell that it happened.

## Decision

**The wiki's durable form becomes an append-only op log; the layer files become derived projections of it.**

`$DSH_HOME/workspace/.dsh/wiki/oplog/ops.jsonl` holds one JSON object per write (`v`, `seq`, `ts`, `by`, `layer`, `op`, `target`, `text`, `intent`, optional `evidence`, `class`). Writes never modify or delete an existing line, so a writer cannot reach another writer's content at all. `watermark.json` records how many bytes of the log have already been folded into the projections, plus the content hash of each layer file at that point.

**The merge lock is an in-process boolean (`tryAcquireMerge`/`releaseMerge`), not a cross-process claim.** The original design used a `mkdir`-based claim directory under `oplog/`. Both of its intended safeguards were unsound: timeout-preemption called `rmdir` on a directory that still held `owner.json`, so it failed with `ENOTEMPTY` instead of `EEXIST` and preemption never worked; and `mkdir` succeeding was not atomic with writing `owner.json`, so a second contender that read a missing owner would steal a live claim and produce two holders. Neither matters here, because `InstanceManager.ensure` returns early when a registration already exists, so one account has at most one live instance, and "concurrent sessions" are interleaved turns inside one single-threaded Node process. `checkMergerPid`/`recordMergerPid` remain as a sanity check that the recorded merger is this process.

**A write renders its own text into the layer file inside a `<!-- PENDING-OPS -->` block, and `stripPendingBlock` removes exactly that block before the content is hashed.** This is what keeps an unmerged write from being invisible to the model on its next turn: the projection the model reads already contains it. `renderPendingBlock` and `stripPendingBlock` are exact inverses, and reconciliation hashes the stripped content — hashing raw bytes instead would fail on every merge, because every append rewrites the file tail.

**Rotation gives each archive a unique name, and archives count as history.** `archiveEpoch.bytes` tracks the current epoch. Reusing an archive filename would overwrite a previous rotation while the log claimed to hold everything, and would break the distinction §9.1 of the spec needs — "just rotated" versus "history is gone" — so `hasOpHistory` treats a non-empty archive directory as evidence that history exists.

**Merging is a state machine driven by mechanical weight, not a timer.** `pendingWeight` sums three inputs — op `class` (`critical` outweighs `normal`), staleness, and conflict — from the ops themselves, with no model in the loop. `mergeGate` compares it against a configurable threshold (default 6, ceiling 50) and returns `idle` or `merge`. A model may also request a merge through a `wiki_merge` tool, and the same gate decides. A fixed interval was rejected: an account that has written nothing for a week should not pay a merge, and one that has written its identity four times in a minute should not wait.

**A missing baseline fails loud rather than overwriting.** `assertMergeBaseline` raises `NoBaselineError` (`E_NO_BASELINE`) when a layer has no ops and nothing to reconcile against, instead of treating absent history as an empty layer and writing over whatever is there. `provisionUserHome` seeds a `baseline` op for every account, new or pre-existing, through `seedBaselineIfMissing` — the scaffold's skeleton text is itself content, so an account created by provisioning but never written to was previously indistinguishable from one whose op history had been lost, and would have hit `E_NO_BASELINE` forever.

**The model-facing surface is `config.wikiV2`, defaulting on**, with `mergeWeightThreshold`, `maxPendingOps`, and `rotateBytes` as deployment tunables in the plugin's `Config`. Setting it `false` restores the whole-file overwrite and its conflict check, which is the documented rollback and keeps the guard note's behavior reachable.

## Alternatives considered

**Cross-process exclusion, via the original `mkdir` claim.** Recorded in the Decision above for why it lost on soundness; it also lost on necessity. A correct implementation would add a fencing token, an expiry, and steal-detection to exclude a second process that this deployment's lifecycle cannot produce.

**Merging on a fixed interval.** Rejected: the schedule would be unrelated to whether there is anything worth merging, so it either burns a model call on an idle account or makes a busy account wait. Weight reads the ops that actually exist, and keeps the decision inspectable as arithmetic rather than as a policy dial.

**Keeping the conflict guard as the primary mechanism and improving its refusal message.** Rejected: a refusal can only tell the model to try again with text it has to merge by hand, which is the work the op log does mechanically and durably. The guard is retained only as the v1 rollback path.

**Rendering nothing into the layer file until a merge runs.** Rejected: the model reads the projection, so an unmerged write would be invisible to it and a second session would happily produce a third version of the same fact. Rendering the pending block keeps the read path honest without making the projection authoritative.

## Consequences

Multiple concurrent sessions on one account now compose instead of overwriting: each `wiki_note` on a whole-replace layer appends a `baseline` op, the projection shows the newest pending text, and the merge folds them under `critical`-weighted review. Every write the model makes is recoverable from `ops.jsonl` alone, so a lost projection is a rebuild rather than a loss.

The costs are real. The wiki is no longer a file the operator can hand-edit and expect to persist — an outside edit is reconciled as a new baseline rather than treated as authority, and the reconciliation hash must be computed on pending-stripped content for it to match at all. Rotation and the watermark add two failure modes (a rotated log whose archive is missing, a watermark ahead of the log) that the v1 single-file design could not have. `shell/src/remote/oplog.ts` carries the mechanism with no `@deepseek-ai/*` imports specifically so its tests run without a model, and `wiki-merge.ts` takes an injected completion so the merge is testable without one too.

Test coverage is 30+ new cases across `shell/tests/oplog.spec.ts`, `wiki-v2-concurrency.spec.ts`, `wiki-v2-merge.spec.ts`, `wiki-v2-provisioning.spec.ts`, `wiki-v2-rotation.spec.ts`, `wiki-v2-weight.spec.ts`, and `wiki-v2-wiring.spec.ts`, including a deliberately lock-free race that is demonstrated to lose an update — the case that earns the lock its place. `runtime-copy-lists.spec.ts` derives the files copied into each account's `plugins/` directory from the module's real imports, because a missing one (`oplog.ts` was omitted from the list at one point) crashes every instance at boot and is invisible to typecheck. `wiki-fs.ts`'s four files keep their shapes; only the write path and the merge changed.
