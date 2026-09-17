/**
 * The semantic merge (spec §10 S4) and its mechanical evidence check (§9.4).
 *
 * The completion is injected, so every case here runs against a stub and no
 * model is called: this file pins the CONTRACT around the model — that a
 * dropped entry is rejected before anything reaches the disk, that the lock is
 * released on every path, that profiles are written before the watermark, and
 * that an external edit is re-baselined rather than reconciled away. Merge
 * *quality* is not assertable here and is covered by sampling per §10 S4.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendOp,
  collectAllOps,
  oplogPaths,
  pendingWeight,
  performMerge,
  readOps,
  readUnmergedOps,
  readWatermark,
  releaseMerge,
  seedBaselineIfMissing,
  tryAcquireMerge,
  type Op,
  type OpLayer,
} from '../src/remote/oplog.ts'
import { wikiPaths } from '../src/remote/wiki-fs.ts'

const IDENTITY = '# identity\n\n## seed\n\noriginal\n'
const PREFERENCES = '# preferences\n\n## seed\n\noriginal\n'

/** A seeded workspace, ready to merge. */
async function workspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-merge-'))
  await mkdir(join(workspaceRoot, '.dsh', 'wiki'), { recursive: true })
  await writeFile(wikiPaths(workspaceRoot).identity, IDENTITY)
  await writeFile(wikiPaths(workspaceRoot).preferences, PREFERENCES)
  seedBaselineIfMissing(workspaceRoot, layer => (layer === 'identity' ? IDENTITY : PREFERENCES))
  releaseMerge(workspaceRoot)
  return workspaceRoot
}

/** Append one op, forcing the merge weight over the threshold by default. */
function note(
  workspaceRoot: string,
  overrides: Partial<Op> = {},
): void {
  appendOp(workspaceRoot, {
    v: 1,
    seq: 1,
    ts: new Date().toISOString(),
    by: 'session-A',
    layer: 'identity',
    op: 'update',
    target: 'added',
    text: 'new fact',
    intent: 'merge test',
    class: 'critical',
    ...overrides,
  })
}

/**
 * Merge with the weight gate forced open. These cases target merge semantics
 * — what is written, what is rejected, what is released — not triggering, so
 * they bypass the threshold the way the manual `wiki_merge` tool does.
 * Threshold behaviour has its own cases below.
 * @param workspaceRoot - the account's private workspace root.
 * @param complete - the stub completion to drive the merge.
 */
function mergeNow(workspaceRoot: string, complete: (prompt: string, layer: OpLayer) => Promise<string>) {
  return performMerge(workspaceRoot, complete, { force: true })
}

/** A completion that returns a fixed profile, counting how often it ran. */
function stub(text: string, calls?: OpLayer[]): (prompt: string, layer: OpLayer) => Promise<string> {
  return (_prompt, layer) => {
    calls?.push(layer)
    return Promise.resolve(text)
  }
}

describe('performMerge: the happy path', () => {
  it('folds ops in, clears the backlog, and advances the watermark to the file size', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot, { target: 'added', text: 'likes TypeScript' })
      const merged = `${IDENTITY}\n## added\n\nlikes TypeScript\n`
      const outcome = await mergeNow(workspaceRoot, stub(merged))
      assert.equal(outcome.merged, true)
      assert.equal(outcome.opsMerged, 1)
      assert.equal(outcome.offset, statSync(oplogPaths(workspaceRoot).opsPath).size)

      const text = await readFile(wikiPaths(workspaceRoot).identity, 'utf8')
      assert.equal(text, merged)
      // Backlog consumed: nothing pending, the gate is idle again.
      assert.deepEqual(readUnmergedOps(workspaceRoot), [])
      assert.equal(pendingWeight(workspaceRoot).state, 'idle')
      assert.equal(readWatermark(workspaceRoot)?.offset, statSync(oplogPaths(workspaceRoot).opsPath).size)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('records the new profile hashes so the next reconciliation agrees', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot)
      const merged = `${IDENTITY}\n## added\n\nnew fact\n`
      await mergeNow(workspaceRoot, stub(merged))
      const watermark = readWatermark(workspaceRoot)
      // A follow-up merge must not see a spurious mismatch (which would append
      // a reconciliation baseline every single time).
      const { createHash } = await import('node:crypto')
      assert.equal(watermark?.profile.identity, createHash('sha256').update(`${merged.trim()}\n`, 'utf8').digest('hex'))
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('merges only the layers that have pending ops', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot, { layer: 'identity', target: 'i' })
      const calls: OpLayer[] = []
      await mergeNow(workspaceRoot, stub(`${IDENTITY}\n## i\n\nx\n`, calls))
      assert.deepEqual(calls, ['identity'], 'preferences had no pending ops and should not cost a model call')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('sends the current profile and the ops to the completion', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot, { target: 'topic', text: 'the fact', intent: 'because reasons' })
      let seen = ''
      await mergeNow(workspaceRoot, (prompt) => {
        seen = prompt
        return Promise.resolve(`${IDENTITY}\n## topic\n\nthe fact\n`)
      })
      assert.match(seen, /CURRENT PROFILE/)
      assert.match(seen, /## seed/)
      assert.match(seen, /NEW RECORDED FACTS/)
      assert.match(seen, /target=topic/)
      assert.match(seen, /because reasons/)
      assert.match(seen, /the fact/)
      // The instruction the safety story rests on must actually be present.
      assert.match(seen, /Preserve every existing entry/)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('performMerge: the evidence check is enforced before any write (§9.4)', () => {
  it('rejects a merge that drops an entry no op targets, leaving the profile untouched', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot, { target: 'added' })
      const before = await readFile(wikiPaths(workspaceRoot).identity, 'utf8')
      const offsetBefore = readWatermark(workspaceRoot)?.offset

      // 'seed' vanishes here with no op asking for it.
      const outcome = await mergeNow(workspaceRoot, stub('# identity\n\n## added\n\nnew fact\n'))
      assert.equal(outcome.merged, false)
      assert.equal(outcome.reason, 'rejected-unevidenced-removal')
      assert.deepEqual(outcome.removedWithoutEvidence, ['seed'])
      // Nothing was written: byte-for-byte identical, watermark unmoved.
      assert.equal(await readFile(wikiPaths(workspaceRoot).identity, 'utf8'), before)
      assert.equal(readWatermark(workspaceRoot)?.offset, offsetBefore)
      // The ops stay pending, so the fact is not lost — it just did not merge.
      assert.equal(readUnmergedOps(workspaceRoot).length, 1)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('accepts the same removal when a pending op targets the entry', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot, { op: 'remove', target: 'seed', text: '' })
      const outcome = await mergeNow(workspaceRoot, stub('# identity\n\n## added\n\nnew fact\n'))
      assert.equal(outcome.merged, true)
      assert.equal((await readFile(wikiPaths(workspaceRoot).identity, 'utf8')).includes('seed'), false)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('does not let a rejection poison the lock', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot)
      await mergeNow(workspaceRoot, stub('# identity\n\n')) // rejected
      // A second attempt must be able to run, which proves the rejection path
      // released the lock.
      const ok = await mergeNow(workspaceRoot, stub(`${IDENTITY}\n## added\n\nnew fact\n`))
      assert.equal(ok.merged, true)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('performMerge: gate interaction and failure paths', () => {
  it('skips below threshold unless forced', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot, { class: 'normal', target: 'one' })
      const below = await performMerge(workspaceRoot, stub(`${IDENTITY}\n## one\n\nnew fact\n`))
      assert.equal(below.merged, false)
      assert.equal(below.reason, 'below-threshold')
      const forced = await performMerge(workspaceRoot, stub(`${IDENTITY}\n## one\n\nnew fact\n`), { force: true })
      assert.equal(forced.merged, true)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('reports busy without waiting when another merge holds the lock', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot)
      assert.equal(tryAcquireMerge(workspaceRoot), true) // simulate a competing merge
      const start = process.hrtime.bigint()
      const outcome = await mergeNow(workspaceRoot, stub(`${IDENTITY}\n## added\n\nx\n`))
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000
      assert.equal(outcome.reason, 'busy')
      assert.ok(elapsedMs < 5, `busy must not wait, took ${String(elapsedMs)}ms`)
      releaseMerge(workspaceRoot)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('leaves the profile and lock intact when the completion throws', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot)
      const before = await readFile(wikiPaths(workspaceRoot).identity, 'utf8')
      const outcome = await mergeNow(workspaceRoot, () => Promise.reject(new Error('provider down')))
      assert.equal(outcome.reason, 'completion-failed')
      assert.equal(await readFile(wikiPaths(workspaceRoot).identity, 'utf8'), before)
      // The lock must be free again, or one provider hiccup would wedge merging
      // for the rest of the process's life.
      assert.equal(tryAcquireMerge(workspaceRoot), true)
      releaseMerge(workspaceRoot)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('refuses to merge a profile with no history behind it (§9.1)', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-merge-'))
    try {
      // Profile content with no oplog at all — the state seeding exists to prevent.
      await writeFile(wikiPaths(workspaceRoot).identity, IDENTITY)
      releaseMerge(workspaceRoot)
      const outcome = await performMerge(workspaceRoot, stub('# identity\n\n'), { force: true })
      assert.equal(outcome.merged, false)
      assert.equal(outcome.reason, 'no-baseline')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('is a no-op with nothing pending', async () => {
    const workspaceRoot = await workspace()
    try {
      const outcome = await performMerge(workspaceRoot, stub('whatever'), { force: true })
      assert.equal(outcome.merged, false)
      assert.equal(outcome.reason, 'idle')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('performMerge: reconciliation of an outside edit (§9.2)', () => {
  it('re-baselines a profile changed outside the mechanism, then merges', async () => {
    const workspaceRoot = await workspace()
    try {
      // A v1 session (old plugin copy) rewrote the whole layer.
      const outsideEdit = '# identity\n\n## seed\n\nrewritten by an old session\n'
      await writeFile(wikiPaths(workspaceRoot).identity, outsideEdit)
      note(workspaceRoot, { target: 'added' })

      const outcome = await mergeNow(workspaceRoot, stub(`${outsideEdit}\n## added\n\nnew fact\n`))
      assert.equal(outcome.rebaselined, true)
      assert.equal(outcome.merged, true)
      // The re-baseline carries the outside edit, so history still explains the profile.
      const baselineOps = collectAllOps(workspaceRoot).filter(op => op.by === 'reconcile')
      assert.equal(baselineOps.length, 1)
      assert.equal(baselineOps[0]?.text, outsideEdit)
      assert.equal(baselineOps[0]?.layer, 'identity')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('does not re-baseline when the profile still matches the watermark', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot)
      const outcome = await mergeNow(workspaceRoot, stub(`${IDENTITY}\n## added\n\nnew fact\n`))
      assert.equal(outcome.rebaselined, false)
      assert.equal(collectAllOps(workspaceRoot).filter(op => op.by === 'reconcile').length, 0)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('performMerge: merge does not corrupt the op stream', () => {
  it('keeps every op, appending nothing on the happy path', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot, { target: 'a' })
      note(workspaceRoot, { target: 'b' })
      const before = readOps(workspaceRoot).length
      await mergeNow(workspaceRoot, stub(`${IDENTITY}\n## a\n\nx\n## b\n\ny\n`))
      assert.equal(readOps(workspaceRoot).length, before, 'the happy path must not append ops')
      assert.equal(readOps(workspaceRoot).filter(op => op.op === 'baseline').length, 2)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('releases the lock even when the evidence check rejects on the second layer', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot, { layer: 'identity', target: 'i' })
      note(workspaceRoot, { layer: 'preferences', target: 'p' })
      const outcome = await mergeNow(workspaceRoot, (_prompt, layer) => Promise.resolve(
        layer === 'identity' ? `${IDENTITY}\n## i\n\nx\n` : '# preferences\n\n', // drops 'seed'
      ))
      assert.equal(outcome.reason, 'rejected-unevidenced-removal')
      // identity passed the check first, but nothing may be written when any
      // layer fails — the merge is all-or-nothing across layers.
      assert.equal(await readFile(wikiPaths(workspaceRoot).identity, 'utf8'), IDENTITY)
      assert.equal(existsSync(wikiPaths(workspaceRoot).preferences), true)
      assert.equal(tryAcquireMerge(workspaceRoot), true)
      releaseMerge(workspaceRoot)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
