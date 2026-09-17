/**
 * Wiki v2 op log: the durable append-only history behind the identity/
 * preferences layers (`wiki-v2-实施规格.md` §3–§4, §9). Three independent
 * pieces live here:
 *
 * - `appendOp`/`readOps`: the NDJSON op stream itself (§3).
 * - `assertMergeBaseline`: the fail-safe that refuses to merge a profile that
 *   has content but no op history behind it, so a missing/lost oplog can
 *   never be misread as "empty history" and silently wipe a profile (§9.1).
 * - `tryAcquireMerge`/`releaseMerge`: an in-process merge lock. Every
 *   account has at most one live instance (`InstanceManager` in
 *   `../account/instance-manager.ts` never starts a second one for the same
 *   user, and a supervised restart is sequential — the old generation fully
 *   exits before the new one starts), so every session touching one
 *   account's wiki data runs in the same single-threaded Node process. There
 *   is no real cross-process race to defend against, so this is a plain
 *   in-memory flag rather than the `mkdir`/`owner.json` cross-process
 *   protocol the spec's v1 draft used (dropped: it had two live races —
 *   preempting a stale claim called `rmdir` on a directory that still held
 *   `owner.json`, and `mkdir` succeeding was not atomic with writing that
 *   file). `checkMergerPid` is a non-blocking sanity check standing in for
 *   that dropped protocol's crash detection: it never blocks a merge, only
 *   logs a warning if this invariant is ever violated.
 * - `seedBaselineIfMissing`: seeds a `baseline` op from the current on-disk
 *   L1/L2 content the first time an account is provisioned with no oplog
 *   yet — the same step for a brand-new account (whose "content" is just
 *   `scaffoldUserWiki`'s skeleton text) as for an account with real
 *   accumulated history predating this module. One path, not a one-off
 *   migration script for pre-existing accounts plus a separate rule for new
 *   ones: {@link assertMergeBaseline} cannot tell those two cases apart on
 *   disk, so provisioning never lets either reach it with an empty oplog.
 *
 * @module dsh-team-shell/oplog
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { wikiPaths } from './wiki-fs.ts'

/** The two whole-replace layers an op may target (mirrors `wiki-fs.ts`'s `WholeReplaceWikiLayer`). */
export type OpLayer = 'identity' | 'preferences'

/** The kinds of change one op may record. */
export type OpKind = 'add' | 'update' | 'remove' | 'replace' | 'baseline'

/** Severity classifying how much an entry matters, carried through to merge review. */
export type OpClass = 'critical' | 'normal'

/** One line of `ops.jsonl` — the append-only truth behind a layer's derived profile file. */
export interface Op {
  /** Schema version; `1` for every op this module writes or reads. */
  v: 1
  /** Writer-local monotonic sequence number, starting at 1; stable-sort tiebreaker only. */
  seq: number
  /** ISO 8601 timestamp with timezone offset. */
  ts: string
  /** Writer identity (session id, or `"migration"` for a seeded baseline). */
  by: string
  /** Which layer this op targets. */
  layer: OpLayer
  /** What kind of change this op records. */
  op: OpKind
  /** The entry this op addresses — a heading, or `__baseline__` for a seeded whole-layer snapshot. */
  target: string
  /** The op's content. */
  text: string
  /** Why the change was made — required so the merger is never left guessing. */
  intent: string
  /** Supporting evidence for the change (a number, a source), if any. */
  evidence?: string
  /** How much this entry matters to merge review. */
  class: OpClass
}

/**
 * Build a `baseline` op: an authoritative full-layer snapshot. One concept
 * covers three callers, which is why it is a factory rather than three
 * hand-built objects — provisioning seeds, reconciliation after an outside
 * edit, and a transitional full-text `wiki_note` call all mean the same
 * thing ("the layer is now this"), and the merge's evidence check treats that
 * meaning identically for all three.
 * @param layer - the layer this snapshot covers.
 * @param text - the layer's full content at this moment.
 * @param by - writer identity (a session id, `"provisioning"`, or `"reconcile"`).
 * @param now - the timestamp to stamp.
 * @param intent - why the snapshot was taken.
 * @returns the op, ready to append.
 */
export function baselineOp(layer: OpLayer, text: string, by: string, now: Date, intent: string): Op {
  return {
    v: 1,
    seq: 1,
    ts: now.toISOString(),
    by,
    layer,
    op: 'baseline',
    target: '__baseline__',
    text,
    intent,
    class: 'critical',
  }
}

/** Oplog file layout under a workspace root's `.dsh/wiki/oplog/` directory. */
export interface OplogPaths {
  dir: string
  opsPath: string
  watermarkPath: string
  claimSanityPath: string
  archiveDir: string
}

/** Resolve the oplog directory layout for a workspace root (mirrors `wikiPaths` in `wiki-fs.ts`). */
export function oplogPaths(workspaceRoot: string): OplogPaths {
  const dir = join(workspaceRoot, '.dsh', 'wiki', 'oplog')
  return {
    dir,
    opsPath: join(dir, 'ops.jsonl'),
    watermarkPath: join(dir, 'watermark.json'),
    claimSanityPath: join(dir, 'last-merger.pid'),
    archiveDir: join(dir, 'archive'),
  }
}

/** Thrown by {@link appendOp} when a line would exceed the single-`write()` atomicity safety margin. */
export class OpTooLargeError extends Error {
  constructor(byteLength: number) {
    super(`op line is ${String(byteLength)} bytes, over the 4096-byte single-write atomicity limit`)
    this.name = 'OpTooLargeError'
  }
}

/** The largest an NDJSON op line (including its trailing newline) may be, in bytes. */
const MAX_OP_LINE_BYTES = 4096

/**
 * Append one op to `ops.jsonl`. Rejects (throwing, file untouched) rather
 * than truncating or splitting an oversized op across lines — a single
 * `appendFileSync` call is the whole atomicity argument, so the line must
 * stay one `write()` worth of bytes (spec §3.2).
 * @param workspaceRoot - the account's private workspace root.
 * @param op - the op to append; `v`/`seq`/`ts` are the caller's responsibility to fill in.
 * @throws {OpTooLargeError} if the serialized line exceeds {@link MAX_OP_LINE_BYTES}.
 */
export function appendOp(workspaceRoot: string, op: Op): void {
  const paths = oplogPaths(workspaceRoot)
  const line = `${JSON.stringify(op)}\n`
  const byteLength = Buffer.byteLength(line, 'utf8')
  // A `baseline` op carries a layer's whole text so the profile stays
  // rebuildable, and a real profile routinely runs past 4 KiB, so baselines
  // are exempt from the concurrent-append bound on purpose. The bound exists
  // to keep one append atomic against other appenders; a baseline is rare and
  // is written either under `O_EXCL` (seeding) or while holding the merge lock
  // (reconciliation), not from the ordinary per-note path.
  if (byteLength > MAX_OP_LINE_BYTES && op.op !== 'baseline') throw new OpTooLargeError(byteLength)
  mkdirSync(paths.dir, { recursive: true })
  // One `appendFileSync` call is one `write(2)` syscall with O_APPEND — the
  // whole atomicity argument for concurrent appenders (spec §3.2).
  appendFileSync(paths.opsPath, line)
}

/** Read every op currently in `ops.jsonl`, in file order (oldest first). */
export function readOps(workspaceRoot: string): Op[] {
  const paths = oplogPaths(workspaceRoot)
  if (!existsSync(paths.opsPath)) return []
  const text = readFileSync(paths.opsPath, 'utf8')
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Op)
}

/** Merge progress: how much of `ops.jsonl` has already been folded into the derived profile files. */
export interface Watermark {
  v: 1
  /** Bytes of the current `ops.jsonl` already merged. */
  offset: number
  /** Content hash of each layer's profile file as of this merge, for §9.2 reconciliation. */
  profile: { identity: string; preferences: string }
  archiveEpoch: { file: string | null; bytes: number }
  updatedAt: string
}

/** Write a file via temp-file-then-rename so a reader never observes a partial write. */
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${String(process.pid)}-${String(Date.now())}`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

/** Read the current watermark, or `undefined` if none has been written yet. */
export function readWatermark(workspaceRoot: string): Watermark | undefined {
  const paths = oplogPaths(workspaceRoot)
  if (!existsSync(paths.watermarkPath)) return undefined
  return JSON.parse(readFileSync(paths.watermarkPath, 'utf8')) as Watermark
}

/**
 * Write the watermark atomically. Callers must write the derived profile
 * files first (their own atomic temp-file-then-rename) and only then call
 * this — never the other way — so a crash between the two leaves the
 * watermark behind the profile it describes, not ahead of it (spec §3.3).
 */
export function writeWatermark(workspaceRoot: string, watermark: Watermark): void {
  const paths = oplogPaths(workspaceRoot)
  mkdirSync(paths.dir, { recursive: true })
  writeAtomic(paths.watermarkPath, `${JSON.stringify(watermark, null, 2)}\n`)
}

/** Thrown by {@link assertMergeBaseline} when a layer has content but no op history behind it. */
export class NoBaselineError extends Error {
  constructor() {
    super('profile has content but no op history (current or archived) — refusing to merge (would wipe the profile)')
    this.name = 'NoBaselineError'
  }
}

/**
 * Whether this workspace has any op history at all — in the current
 * `ops.jsonl` or in any rotation archive. Both count: a workspace that just
 * rotated has an empty `ops.jsonl` and its whole history in `archive/`, and
 * that is a normal state, not a lost oplog.
 */
function hasOpHistory(paths: OplogPaths): boolean {
  try {
    if (existsSync(paths.opsPath) && statSync(paths.opsPath).size > 0) return true
  } catch {
    // Treat an unreadable current file as "nothing here" and let the archive
    // check below decide; a genuinely unreadable oplog surfaces on the next merge attempt.
  }
  try {
    return readdirSync(paths.archiveDir).some(name => name.startsWith('ops-') && name.endsWith('.jsonl')
      && statSync(join(paths.archiveDir, name)).size > 0)
  } catch {
    return false // No archive directory: nothing archived yet.
  }
}

/**
 * Fail-safe gate (spec §9.1, S0): refuse to merge when a layer's derived
 * profile file has content but there is no op history anywhere behind it.
 * The only way to reach that state honestly is a lost/never-seeded oplog —
 * treating it as "no history" would merge down to an empty profile, so this
 * throws instead and leaves the existing profile file untouched.
 *
 * History counts as present if it lives in the current `ops.jsonl` **or** in
 * any rotation archive. That distinction is the whole point: immediately
 * after a rotation the current file is legitimately empty while the entire
 * history sits in `archive/`, so a check that only looked at the current
 * file would misread "just rotated" as "oplog lost" and reject the first
 * merge after every rotation.
 * @param workspaceRoot - the account's private workspace root.
 * @param profileNonEmpty - whether `identity` or `preferences` currently has content.
 * @throws {NoBaselineError} if the fail-safe condition holds.
 */
export function assertMergeBaseline(workspaceRoot: string, profileNonEmpty: boolean): void {
  if (!profileNonEmpty) return
  if (!hasOpHistory(oplogPaths(workspaceRoot))) throw new NoBaselineError()
}

/**
 * In-process merge locks, one flag per workspace root. A plain `Map` (not a
 * single module-level boolean) so multiple accounts' workspaces in the same
 * test process — or, in principle, any future in-process multi-tenant
 * runner — do not share one lock; in production exactly one workspace root
 * is ever touched per process anyway.
 */
const merging = new Map<string, boolean>()

/**
 * Try to take this workspace's merge lock. Returns `false` immediately if
 * already held — no sleep, no retry, no queue (spec §4's "no wait path"
 * rule). A crash drops the lock for free: `merging` lives only in process
 * memory, so the next generation starts with every workspace unlocked.
 * @param workspaceRoot - the account's private workspace root.
 * @returns `true` if the lock was acquired, `false` if already held.
 */
export function tryAcquireMerge(workspaceRoot: string): boolean {
  if (merging.get(workspaceRoot) === true) return false
  merging.set(workspaceRoot, true)
  return true
}

/** Release a merge lock previously taken by {@link tryAcquireMerge}. */
export function releaseMerge(workspaceRoot: string): void {
  merging.set(workspaceRoot, false)
}

/** How long a `last-merger.pid` timestamp may age before {@link checkMergerPid} warns, in ms. */
const MERGER_SANITY_WINDOW_MS = 120_000

/**
 * Record that this process just merged this workspace. Purely a sanity-check
 * breadcrumb, never a lock: {@link checkMergerPid} only ever logs.
 */
export function recordMergerPid(workspaceRoot: string): void {
  const paths = oplogPaths(workspaceRoot)
  mkdirSync(paths.dir, { recursive: true })
  writeAtomic(paths.claimSanityPath, JSON.stringify({ pid: process.pid, at: Date.now() }))
}

/**
 * Non-blocking sanity check standing in for the dropped cross-process claim
 * protocol's crash detection (spec §4): if some other, still-recent PID
 * merged this workspace, the "one live instance per account" invariant this
 * module's locking depends on has been violated (e.g. an operator started a
 * second instance for debugging, or a future horizontal-scale deployment).
 * Only warns — never blocks, never retries, never throws — since by design
 * this module has no way to enforce cross-process exclusion at all.
 * @param workspaceRoot - the account's private workspace root.
 * @param warn - sink for the diagnostic message; defaults to `console.warn`.
 */
export function checkMergerPid(workspaceRoot: string, warn: (message: string) => void = console.warn): void {
  const paths = oplogPaths(workspaceRoot)
  if (!existsSync(paths.claimSanityPath)) return
  let record: { pid: number; at: number }
  try {
    record = JSON.parse(readFileSync(paths.claimSanityPath, 'utf8')) as { pid: number; at: number }
  } catch {
    return // Corrupt breadcrumb: nothing to compare against, not worth warning about.
  }
  if (record.pid === process.pid) return
  if (Date.now() - record.at > MERGER_SANITY_WINDOW_MS) return // Stale enough to ignore — likely a prior generation.
  warn(
    `dsh-team-shell: workspace "${workspaceRoot}" was merged by pid ${String(record.pid)} within the last `
    + `${String(MERGER_SANITY_WINDOW_MS / 1000)}s, but this is pid ${String(process.pid)} — the "one live `
    + 'instance per account" invariant the in-process merge lock depends on may be violated.',
  )
}

/** SHA-256 hex digest of a layer's text, for the watermark's `profile` reconciliation hashes. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Seed the `baseline` op (and its matching watermark) from whatever identity/
 * preferences content is already on disk, when the account has no op history
 * yet. This runs at provisioning time and is the single path every account
 * takes — a brand-new account (whose content is `scaffoldUserWiki`'s
 * skeleton text) and one carrying real history from before this module
 * existed both look identical on disk, and {@link assertMergeBaseline} has
 * no way to tell them apart. Making provisioning always seed means neither
 * can ever reach the fail-safe with an empty oplog, so there is no separate
 * migration step for pre-existing accounts and no separate rule for new
 * ones.
 *
 * **Baseline lines may exceed {@link MAX_OP_LINE_BYTES}** — a deliberate
 * carve-out from {@link appendOp}'s rule, not an oversight. A baseline
 * carries the layer's entire pre-existing text (spec §8.2) so the profile
 * can be rebuilt from history, and a real profile routinely runs past 4 KiB
 * (one production account's identity layer alone is 7.4 KiB). The 4 KiB
 * bound exists to keep one concurrent append atomic; a seed happens exactly
 * once, before the instance starts, under `O_EXCL` with no competing
 * appender, so no bound is needed for correctness. Do not "tidy" this by
 * routing it through {@link appendOp}: that would reject the baseline of
 * every account whose profile is larger than 4 KiB.
 *
 * Idempotent: an account that already has a non-empty `ops.jsonl` is left
 * untouched, so this is safe to call on every provisioning run. A crash
 * mid-seed leaves `ops.jsonl` present but empty; the next run rewrites it
 * from the then-current profile content.
 * @param workspaceRoot - the account's private workspace root.
 * @param readLayer - reads a whole-replace layer's current on-disk content.
 * @returns `true` if this call seeded the baseline, `false` if it was already present.
 */
export function seedBaselineIfMissing(
  workspaceRoot: string,
  readLayer: (layer: OpLayer) => string,
): boolean {
  const paths = oplogPaths(workspaceRoot)
  if (existsSync(paths.opsPath)) {
    try {
      if (statSync(paths.opsPath).size > 0) return false
    } catch {
      return false // Vanished between the two calls; treat as not-ours-to-seed this run.
    }
  }
  const identity = readLayer('identity')
  const preferences = readLayer('preferences')
  if (identity === '' && preferences === '') return false // Nothing to protect: the fail-safe already passes on an empty profile.

  mkdirSync(paths.dir, { recursive: true })
  const ts = new Date().toISOString()
  const layers: [OpLayer, string][] = [['identity', identity], ['preferences', preferences]]
  const lines = layers
    .filter(([, text]) => text !== '')
    .map(([layer, text], index) => JSON.stringify({
      ...baselineOp(layer, text, 'provisioning', new Date(ts), 'provisioning-time baseline of the pre-existing profile content'),
      seq: index + 1,
    } satisfies Op).concat('\n'))
    .join('')
  // `wx` (O_EXCL) so two concurrent provisioners cannot both seed; the loser
  // re-reads on its next run. A zero-byte leftover from a crashed seeder is
  // the one case that must be rewritten rather than skipped.
  // Written directly rather than via `appendOp`: a baseline line is allowed
  // to exceed the 4 KiB concurrent-append bound (see this function's doc).
  let fd: number
  try {
    fd = openSync(paths.opsPath, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    fd = openSync(paths.opsPath, 'w')
  }
  try {
    writeSync(fd, lines)
  } finally {
    closeSync(fd)
  }

  writeWatermark(workspaceRoot, {
    v: 1,
    offset: statSync(paths.opsPath).size,
    profile: { identity: sha256(identity), preferences: sha256(preferences) },
    archiveEpoch: { file: null, bytes: 0 },
    updatedAt: ts,
  })
  return true
}

/** Opening marker of the rendered block holding not-yet-merged ops (spec §6). */
export const PENDING_START = '<!-- PENDING-OPS -->'

/** Closing marker of the rendered block holding not-yet-merged ops (spec §6). */
export const PENDING_END = '<!-- /PENDING-OPS -->'

/**
 * A short human-readable summary of one op, for the pending block. Deliberately
 * a gist rather than the full `text` (spec §6: the block sits in the always
 * injected layer, so a verbatim dump would pollute every turn's context).
 * @param op - the op to summarize.
 */
function summarizeOp(op: Op): string {
  const firstLine = op.text.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
  const gist = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine
  return `- [${op.layer}/${op.op} ${op.target}] ${gist}`
}

/**
 * Remove the rendered pending block from a profile file's text, returning the
 * pure profile. Any text before the opening marker is returned byte-for-byte,
 * which is what makes {@link stripPendingBlock} the exact inverse of
 * {@link renderPendingBlock}: `stripPendingBlock(renderPendingBlock(pure, ops))`
 * always reproduces `pure` exactly.
 * @param text - the profile file's current content.
 * @returns the content with any pending block removed.
 */
export function stripPendingBlock(text: string): string {
  const start = text.indexOf(PENDING_START)
  if (start < 0) return text
  return text.slice(0, start)
}

/**
 * Render the pending-ops block for one layer, or `''` when nothing is pending.
 * Reads as a plain reminder that these facts are recorded but not yet folded
 * into the profile above.
 * @param ops - the unmerged ops for this layer, in file order.
 * @returns the block including both markers and a trailing newline, or `''`.
 */
export function renderPendingBlock(ops: readonly Op[]): string {
  if (ops.length === 0) return ''
  const stamp = ops[ops.length - 1]?.ts ?? new Date().toISOString()
  return [
    PENDING_START,
    `（待合并 · ${stamp}）`,
    ...ops.map(summarizeOp),
    PENDING_END,
    '',
  ].join('\n')
}

/**
 * Re-derive each layer's pending block from the op stream and write it into
 * the layer's profile file. Every session that appends calls this, so the
 * block is always rebuildable from `ops.jsonl` alone: the whole file's
 * existing block is stripped first, then the currently-unmerged ops are
 * rendered fresh. That is why concurrent callers cannot accumulate or
 * interleave blocks — the last writer wins, and whatever it writes is a
 * complete, correct derivation rather than an increment.
 *
 * Pure sync fs, so concurrent callers within the process cannot interleave;
 * their calls simply serialize, each producing a complete block.
 * @param workspaceRoot - the account's private workspace root.
 * @returns how many ops are rendered as pending, per layer.
 */
export function renderPendingIntoProfiles(workspaceRoot: string): Record<OpLayer, number> {
  const pending = readUnmergedOps(workspaceRoot)
  const paths = wikiPaths(workspaceRoot)
  const counts: Record<OpLayer, number> = { identity: 0, preferences: 0 }
  for (const layer of ['identity', 'preferences'] as const) {
    const path = paths[layer]
    if (!existsSync(path)) continue
    const current = readFileSync(path, 'utf8')
    const layerOps = pending.filter(op => op.layer === layer)
    counts[layer] = layerOps.length
    // Stripping first is what makes this idempotent under repeated and
    // concurrent calls: the block is re-derived, never appended to.
    const next = `${stripPendingBlock(current)}${renderPendingBlock(layerOps)}`
    if (next !== current) writeFileSync(path, next)
  }
  return counts
}

/**
 * The ops not yet folded into the profile — everything after the watermark's
 * byte offset in `ops.jsonl`, in file order.
 * @param workspaceRoot - the account's private workspace root.
 */
export function readUnmergedOps(workspaceRoot: string): Op[] {
  const paths = oplogPaths(workspaceRoot)
  if (!existsSync(paths.opsPath)) return []
  const offset = readWatermark(workspaceRoot)?.offset ?? 0
  const all = readFileSync(paths.opsPath, 'utf8')
  // The offset always lands on a line boundary (it is the file size recorded
  // after a completed merge); the guard skips a partial leading line anyway so
  // a torn write can never make this throw on a malformed fragment.
  let start = 0
  if (offset > 0) {
    const bytes = Buffer.from(all, 'utf8')
    start = bytes.subarray(0, Math.min(offset, bytes.length)).toString('utf8').length
    if (start > 0 && all[start - 1] !== '\n') {
      const nextLine = all.indexOf('\n', start)
      start = nextLine < 0 ? all.length : nextLine + 1
    }
  }
  return all.slice(start).split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Op)
}

/**
 * Markdown headings in a profile, in order — the entry identifiers the
 * evidence check (spec §9.4) works over.
 * @param profileText - a profile's pure text.
 */
export function profileEntries(profileText: string): string[] {
  return profileText.split('\n')
    .filter(line => /^#{1,6}\s+\S/.test(line))
    .map(line => line.replace(/^#{1,6}\s+/, '').trim())
}

/**
 * Entries that disappeared from a profile without any pending op asking for
 * their removal — the mechanical evidence check of spec §9.4. An entry may
 * vanish only when an unmerged `remove`/`replace` op names it as its target;
 * every other disappearance means the merge dropped content, and the caller
 * must reject the merge and keep the old profile.
 *
 * A `baseline` op is itself sufficient evidence for every removal, because its
 * contract is "this is the whole layer as of now" — an entry absent from it was
 * dropped by whoever wrote it, deliberately. That is what lets the transitional
 * full-text `wiki_note` call (spec §11.1) keep working: it records a baseline
 * rather than overwriting, so nothing is lost and nothing gets rejected.
 *
 * This is deliberately a pure function over text and ops: the safety judgment
 * never consults a model, so it is deterministic and directly testable.
 * @param before - the profile's pure text before the merge.
 * @param after - the profile's pure text the merge produced.
 * @param pendingOps - the unmerged ops the merge was derived from.
 * @returns the entry titles removed without an op to justify them.
 */
export function findUnevidencedRemovals(
  before: string,
  after: string,
  pendingOps: readonly Op[],
): string[] {
  if (pendingOps.some(op => op.op === 'baseline')) return []
  const surviving = profileEntries(after)
  const evidence = new Set(
    pendingOps
      .filter(op => op.op === 'remove' || op.op === 'replace')
      .map(op => op.target),
  )
  return profileEntries(before)
    .filter(entry => !surviving.includes(entry) && !evidence.has(entry))
}


/** Base merge weight contributed by one op, by its `class`. */
const CLASS_WEIGHT: Record<OpClass, number> = { critical: 3, normal: 1 }

/** Extra weight when an op targets an entry the profile already consolidated (the profile is now stale). */
const STALE_TARGET_WEIGHT = 2

/** Extra weight when two pending ops target the same entry: the pending block now contradicts itself. */
const CONFLICT_WEIGHT = 6

/** Default accumulated weight at which a merge becomes warranted. */
export const DEFAULT_MERGE_WEIGHT_THRESHOLD = 6

/** Hard ceiling on unmerged ops, past which a merge is forced regardless of weight. */
export const DEFAULT_MAX_PENDING_OPS = 50

/** Why a merge is or is not warranted, for logging and for the trigger decision. */
export type PendingState =
  /** No unmerged ops. */
  | 'idle'
  /** Unmerged ops exist, but their weight is below the threshold. */
  | 'accumulating'
  /** Weight threshold reached, or the pending-op ceiling hit: a merge should run. */
  | 'warranted'

/** The accumulated-weight picture for one workspace's unmerged ops. */
export interface PendingWeight {
  /** Which state the pending backlog is in. */
  readonly state: PendingState
  /** Summed weight of every unmerged op. */
  readonly weight: number
  /** The threshold this weight was compared against. */
  readonly threshold: number
  /** How many ops are unmerged. */
  readonly count: number
  /** Unmerged ops that share a `target` with another unmerged op — the strongest merge signal. */
  readonly conflicts: number
}

/**
 * Read a layer's pure profile text (pending block stripped), for the
 * "target already consolidated" weight signal.
 * @param workspaceRoot - the account's private workspace root.
 */
function pureProfileText(workspaceRoot: string): string {
  const paths = wikiPaths(workspaceRoot)
  return (['identity', 'preferences'] as const)
    .map(layer => (existsSync(paths[layer]) ? stripPendingBlock(readFileSync(paths[layer], 'utf8')) : ''))
    .join('\n')
}

/**
 * Accumulated merge weight of this workspace's unmerged ops, and whether that
 * warrants a merge. Pure computation over already-durable state — no model
 * call, no clock, no I/O beyond reading the op stream and the profiles — so
 * it can gate the merge on the critical path without violating §0's "no model
 * calls on the critical path" or "no timers" constraints.
 *
 * The weight deliberately encodes three mechanically-detectable signals
 * rather than any judgment of importance:
 * - `class`: a `critical` op counts for more than a `normal` one (3 vs 1).
 * - staleness: an op whose target is already a consolidated profile entry
 *   means the profile now disagrees with recorded fact, so it counts +2.
 * - conflict: two unmerged ops on the same target make the pending block
 *   self-contradictory, which is the most urgent case and counts +6 each.
 * The pending-op ceiling exists so a backlog can never grow unbounded while
 * waiting for weight that a stream of low-weight ops would never reach.
 * @param workspaceRoot - the account's private workspace root.
 * @param threshold - weight at which a merge becomes warranted (default {@link DEFAULT_MERGE_WEIGHT_THRESHOLD}).
 * @param maxPendingOps - unmerged op count that forces a merge regardless of weight (default {@link DEFAULT_MAX_PENDING_OPS}).
 * @returns the pending state, its weight, and the signals that produced it.
 */
export function pendingWeight(
  workspaceRoot: string,
  threshold: number = DEFAULT_MERGE_WEIGHT_THRESHOLD,
  maxPendingOps: number = DEFAULT_MAX_PENDING_OPS,
): PendingWeight {
  const pending = readUnmergedOps(workspaceRoot)
  if (pending.length === 0) {
    return { state: 'idle', weight: 0, threshold, count: 0, conflicts: 0 }
  }
  const consolidated = new Set(profileEntries(pureProfileText(workspaceRoot)))
  const targetCounts = new Map<string, number>()
  for (const op of pending) targetCounts.set(op.target, (targetCounts.get(op.target) ?? 0) + 1)
  let conflicts = 0
  let weight = 0
  for (const op of pending) {
    weight += CLASS_WEIGHT[op.class]
    if (consolidated.has(op.target)) weight += STALE_TARGET_WEIGHT
    if ((targetCounts.get(op.target) ?? 0) > 1) {
      weight += CONFLICT_WEIGHT
      conflicts += 1
    }
  }
  const warranted = weight >= threshold || pending.length >= maxPendingOps
  return { state: warranted ? 'warranted' : 'accumulating', weight, threshold, count: pending.length, conflicts }
}

/** What the merge gate decided to do about the current pending backlog. */
export interface MergeDecision {
  /** `merge` — the caller now holds the lock and must release it; `busy` — another session holds it; `skip` — no merge needed. */
  readonly action: 'merge' | 'busy' | 'skip'
  /** The weight picture the decision was made from. */
  readonly state: PendingWeight
  /** Present when `action` is `skip`: why no merge was attempted. */
  readonly reason?: 'idle' | 'below-threshold'
}

/**
 * The single place the merge state machine is evaluated, shared by every
 * trigger (the automatic post-`wiki_note` path, session disposal, and the
 * model-callable manual tool). Recomputing this logic per trigger would let
 * the paths drift; the gate is cheap and pure, so there is no reason to.
 *
 * Returns **without waiting** in every case: a merge it may not run is
 * reported as `busy` or `skip` and the caller moves on (§4, §5.3).
 *
 * ⚠️ **Ownership contract**: when this returns `action: 'merge'`, the caller
 * has acquired the workspace's merge lock and **must** call
 * {@link releaseMerge} when the merge finishes, including on failure. The
 * gate never releases it, because only the caller knows when the merge is
 * actually done.
 * @param workspaceRoot - the account's private workspace root.
 * @param options.force - bypass the weight threshold (but not the idle check
 *   or the lock). Set by the manual tool, where the model has judged a merge
 *   worthwhile; `idle` still skips, since there would be nothing to merge.
 * @param options.threshold - override the weight threshold.
 * @param options.maxPendingOps - override the pending-op ceiling.
 * @returns the decision plus the state it was derived from.
 */
export function mergeGate(
  workspaceRoot: string,
  options: { force?: boolean; threshold?: number; maxPendingOps?: number } = {},
): MergeDecision {
  const state = pendingWeight(workspaceRoot, options.threshold, options.maxPendingOps)
  if (state.state === 'idle') return { action: 'skip', state, reason: 'idle' }
  if (state.state === 'accumulating' && options.force !== true) {
    return { action: 'skip', state, reason: 'below-threshold' }
  }
  if (!tryAcquireMerge(workspaceRoot)) return { action: 'busy', state }
  return { action: 'merge', state }
}

/** Default `ops.jsonl` size at which the current file is rotated into the archive, in bytes. */
export const DEFAULT_ROTATE_BYTES = 1024 * 1024

/** Result of a rotation check. */
export interface RotationResult {
  /** Whether this call rotated the file. */
  readonly rotated: boolean
  /** The archive filename created, when `rotated` is true. */
  readonly archiveFile?: string
  /** The rotated file's size in bytes, when `rotated` is true. */
  readonly bytes?: number
}

/** `YYYYMM` for a timestamp, the month component of an archive filename. */
function archiveMonth(now: Date): string {
  return `${String(now.getUTCFullYear())}${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * The archive filename for the next rotation in `month`, numbered so that a
 * second rotation in the same month never collides with the first. Unique
 * names are the whole point (spec §7): a month-keyed name would make the
 * second rotation's rename replace the first archive, destroying the
 * `baseline` op it holds and with it the ability to rebuild the profile.
 * @param archiveDir - the archive directory.
 * @param month - the `YYYYMM` prefix.
 */
function nextArchiveName(archiveDir: string, month: string): string {
  const prefix = `ops-${month}-`
  let highest = 0
  try {
    for (const name of readdirSync(archiveDir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.jsonl')) continue
      const serial = Number(name.slice(prefix.length, -'.jsonl'.length))
      if (Number.isInteger(serial)) highest = Math.max(highest, serial)
    }
  } catch {
    // No archive directory yet: this is the first rotation.
  }
  return `${prefix}${String(highest + 1).padStart(3, '0')}.jsonl`
}

/**
 * Rotate the current `ops.jsonl` into `archive/` once it exceeds `maxBytes`,
 * so an account's op stream cannot grow without bound. Per spec §7 this only
 * archives: it never merges, and it takes no lock, because `rename` is atomic
 * and nothing else about it is racy.
 *
 * Two things must move together with the file, or the bookkeeping goes wrong:
 * - `watermark.offset` is an offset **into the current file**, so it resets to
 *   0 — every op now in the archive was already merged by construction.
 * - `watermark.archiveEpoch` records **this** rotation's file and byte count.
 *   It is deliberately not a running total across all history: a cumulative
 *   number would exceed the named file's actual size and mislead any later
 *   reconciliation.
 *
 * The profile hashes in the watermark are left untouched, since rotation does
 * not change the profiles.
 * @param workspaceRoot - the account's private workspace root.
 * @param maxBytes - rotate when the current file exceeds this (default {@link DEFAULT_ROTATE_BYTES}).
 * @param now - clock injection for the archive's month component and the watermark timestamp.
 * @returns whether a rotation happened, and what it produced.
 */
export function rotateIfNeeded(
  workspaceRoot: string,
  maxBytes: number = DEFAULT_ROTATE_BYTES,
  now: Date = new Date(),
): RotationResult {
  const paths = oplogPaths(workspaceRoot)
  if (!existsSync(paths.opsPath)) return { rotated: false }
  const size = statSync(paths.opsPath).size
  if (size <= maxBytes) return { rotated: false }

  mkdirSync(paths.archiveDir, { recursive: true })
  const archiveFile = nextArchiveName(paths.archiveDir, archiveMonth(now))
  // Atomic: readers see either the old ops.jsonl or the new empty one, never a
  // partial file. Nothing appended after this lands in the archive, because
  // appends reopen the path rather than holding a descriptor.
  renameSync(paths.opsPath, join(paths.archiveDir, archiveFile))

  const watermark = readWatermark(workspaceRoot)
  writeWatermark(workspaceRoot, {
    v: 1,
    offset: 0,
    // Rotation does not touch the profiles, so their hashes carry over
    // verbatim; an absent watermark means there was nothing merged yet.
    profile: watermark?.profile ?? { identity: sha256(''), preferences: sha256('') },
    archiveEpoch: { file: archiveFile, bytes: size },
    updatedAt: now.toISOString(),
  })
  return { rotated: true, archiveFile, bytes: size }
}

/**
 * Every op this workspace has ever recorded, oldest first: rotation archives
 * in filename order, then the current `ops.jsonl`. This is what makes the
 * profile rebuildable from history (spec §2, §11.3) — the archives are not
 * disposable intermediate state, and a check that only read the current file
 * would silently "rebuild" an empty profile.
 * @param workspaceRoot - the account's private workspace root.
 */
export function collectAllOps(workspaceRoot: string): Op[] {
  const paths = oplogPaths(workspaceRoot)
  const opLinesIn = (file: string): Op[] => {
    const text = readFileSync(file, 'utf8')
    return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Op)
  }
  let archives: string[] = []
  try {
    archives = readdirSync(paths.archiveDir)
      .filter(name => name.startsWith('ops-') && name.endsWith('.jsonl'))
      .sort()
      .map(name => join(paths.archiveDir, name))
  } catch {
    archives = [] // No archive directory yet.
  }
  const fromArchives = archives.flatMap(file => opLinesIn(file))
  return existsSync(paths.opsPath) ? [...fromArchives, ...opLinesIn(paths.opsPath)] : fromArchives
}

/** Caller-supplied model completion: turns a merge prompt into the merged layer text. */
export type MergeCompletion = (prompt: string, layer: OpLayer) => Promise<string>

/** What {@link performMerge} did, and why. */
export interface MergeOutcome {
  /** Whether any layer's profile was rewritten. */
  readonly merged: boolean
  /** Why nothing was merged, when `merged` is false. */
  readonly reason?:
    | 'idle'
    | 'below-threshold'
    | 'busy'
    | 'no-baseline'
    | 'rejected-unevidenced-removal'
    | 'completion-failed'
  /** Entries the merge tried to drop without an op justifying it, when rejected. */
  readonly removedWithoutEvidence?: string[]
  /** How many unmerged ops the merge folded in. */
  readonly opsMerged?: number
  /** The watermark offset after a successful merge. */
  readonly offset?: number
  /** Set when reconciliation had to re-baseline before merging (spec §9.2). */
  readonly rebaselined?: boolean
}

/**
 * The merge instruction. Written as an explicit, mechanical contract rather
 * than a vague "merge this": the whole safety story depends on the merge
 * preserving entries it was not asked to drop, and on returning ONLY the
 * layer text so the caller can diff it against the evidence check.
 */
function buildMergePrompt(layer: OpLayer, profile: string, pending: readonly Op[]): string {
  const opLines = pending.map(op => [
    `- op=${op.op} target=${op.target} class=${op.class} by=${op.by} ts=${op.ts}`,
    `  intent: ${op.intent}`,
    ...op.evidence === undefined ? [] : [`  evidence: ${op.evidence}`],
    `  text: ${JSON.stringify(op.text)}`,
  ].join('\n')).join('\n')
  return [
    `You are maintaining the "${layer}" layer of a user's durable profile.`,
    'Apply the NEW RECORDED FACTS below to the CURRENT PROFILE and return the complete updated profile.',
    '',
    'Rules, in order of importance:',
    '1. Preserve every existing entry unless an op below explicitly removes or replaces it.',
    '   Never drop, merge away, or summarize an entry that no op targets.',
    '2. Integrate the new facts into the entries they belong to; do not append a separate',
    '   changelog or a list of changes.',
    '3. `remove` deletes its target entry. `replace` rewrites it. `add` creates one.',
    '   `update` revises its target (or adds it when absent).',
    '4. Resolve contradictions by preferring the newer op, and state the fact once.',
    '5. Keep the document concise. Preserve the existing heading structure and language.',
    '6. Return ONLY the profile document. No preamble, no commentary, no code fences.',
    '',
    '=== CURRENT PROFILE ===',
    profile.trim() === '' ? '(empty)' : profile.trim(),
    '=== END CURRENT PROFILE ===',
    '',
    '=== NEW RECORDED FACTS (in order) ===',
    opLines,
    '=== END NEW RECORDED FACTS ===',
  ].join('\n')
}

/**
 * Append a `baseline` op describing a layer's current content, used when
 * reconciliation finds the profile changed outside this mechanism
 * (spec §9.2). Taking the current content as the new baseline is what lets
 * the following merge proceed without treating the external edit as
 * something the pending ops meant to remove.
 * @param workspaceRoot - the account's private workspace root.
 * @param layer - the layer whose content to re-baseline.
 * @param text - the layer's current pure content.
 * @param now - clock injection for the op timestamp.
 */
function appendReconciliationBaseline(workspaceRoot: string, layer: OpLayer, text: string, now: Date): void {
  appendOp(workspaceRoot, baselineOp(layer, text, 'reconcile', now, 'profile changed outside the op stream; re-baselining before merge'))
}

/**
 * Fold every unmerged op into the derived profiles, then advance the
 * watermark. This is the whole merge state machine in one place: it takes the
 * merge lock through {@link mergeGate} and **always releases it**, including
 * on every failure path, so no trigger can leak the lock by forgetting to.
 *
 * Order is load-bearing (spec §3.3): the profile files are written first, and
 * the watermark that describes them second — never the reverse, or a crash in
 * between would leave the watermark claiming work the profiles do not contain.
 *
 * The safety judgment is mechanical (spec §9.4): if the completion drops an
 * entry that no pending `remove`/`replace` op targets, the whole merge is
 * rejected and the existing profiles are left byte-for-byte untouched. The
 * model is never asked whether its own output is acceptable.
 * @param workspaceRoot - the account's private workspace root.
 * @param complete - the model completion to call, one call per layer that has pending ops.
 * @param options.force - bypass the weight threshold (manual trigger only).
 * @param options.threshold - override the weight threshold.
 * @param options.maxPendingOps - override the pending-op ceiling.
 * @param options.now - clock injection.
 * @returns what happened, including the reason when nothing merged.
 */
export async function performMerge(
  workspaceRoot: string,
  complete: MergeCompletion,
  options: { force?: boolean; threshold?: number; maxPendingOps?: number; now?: Date } = {},
): Promise<MergeOutcome> {
  const now = options.now ?? new Date()
  // §9.1 runs BEFORE the gate, so an inconsistent state (a profile with content
  // and no history behind it) is reported as `no-baseline` rather than being
  // silently indistinguishable from "nothing to merge". Nothing is written
  // either way — fail-closed — but the two conditions need different names,
  // because one is routine and the other needs attention.
  try {
    const profilePath = (layer: OpLayer): string => {
      const path = wikiPaths(workspaceRoot)[layer]
      return existsSync(path) ? stripPendingBlock(readFileSync(path, 'utf8')) : ''
    }
    assertMergeBaseline(workspaceRoot, profilePath('identity') !== '' || profilePath('preferences') !== '')
  } catch {
    return { merged: false, reason: 'no-baseline' }
  }
  const decision = mergeGate(workspaceRoot, options)
  if (decision.action === 'skip') {
    return decision.reason === 'idle' ? { merged: false, reason: 'idle' } : { merged: false, reason: 'below-threshold' }
  }
  if (decision.action === 'busy') return { merged: false, reason: 'busy' }

  try {
    const paths = oplogPaths(workspaceRoot)
    const pureNow = (layer: OpLayer): string => {
      const path = wikiPaths(workspaceRoot)[layer]
      return existsSync(path) ? stripPendingBlock(readFileSync(path, 'utf8')) : ''
    }
    const pendingBefore = readUnmergedOps(workspaceRoot)

    const watermarkBefore = readWatermark(workspaceRoot)

    // §9.2: if the profile no longer matches what the watermark recorded, some
    // writer outside this mechanism changed it. Re-baseline first so the merge
    // treats the current content as the starting point rather than as
    // something to be reconciled away.
    let rebaselined = false
    if (watermarkBefore !== undefined) {
      for (const layer of ['identity', 'preferences'] as const) {
        if (sha256(pureNow(layer)) !== watermarkBefore.profile[layer]) {
          appendReconciliationBaseline(workspaceRoot, layer, pureNow(layer), now)
          rebaselined = true
        }
      }
    }

    // Each layer is merged with its own completion, so an unchanged layer
    // costs nothing.
    const results = new Map<OpLayer, string>()
    for (const layer of ['identity', 'preferences'] as const) {
      const layerOps = pendingBefore.filter(op => op.layer === layer)
      if (layerOps.length === 0) continue
      let candidate: string
      try {
        candidate = await complete(buildMergePrompt(layer, pureNow(layer), layerOps), layer)
      } catch {
        return { merged: false, reason: 'completion-failed', rebaselined }
      }
      // §9.4, checked before anything touches the disk.
      const unevidenced = findUnevidencedRemovals(pureNow(layer), candidate, layerOps)
      if (unevidenced.length > 0) {
        return { merged: false, reason: 'rejected-unevidenced-removal', removedWithoutEvidence: unevidenced, rebaselined }
      }
      results.set(layer, candidate)
    }
    if (results.size === 0) return { merged: false, reason: 'idle', rebaselined }

    // Profiles first (atomic per file), watermark second.
    for (const [layer, text] of results) {
      writeAtomic(wikiPaths(workspaceRoot)[layer], `${text.trim()}\n`)
    }
    const offset = statSync(paths.opsPath).size
    writeWatermark(workspaceRoot, {
      v: 1,
      offset,
      profile: { identity: sha256(pureNow('identity')), preferences: sha256(pureNow('preferences')) },
      archiveEpoch: watermarkBefore?.archiveEpoch ?? { file: null, bytes: 0 },
      updatedAt: now.toISOString(),
    })
    return { merged: true, opsMerged: pendingBefore.length, offset, rebaselined }
  } finally {
    releaseMerge(workspaceRoot)
  }
}
