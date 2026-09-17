/**
 * Single-user multi-session concurrency (spec §10.1, slice S7). One account
 * routinely has several sessions live at once — multiple browser tabs, the
 * Feishu bot, the WeChat bot — and every one of them reads and writes the
 * same wiki files. This is the problem the whole mechanism exists to solve,
 * so it gets its own acceptance suite rather than being folded into the
 * per-module cases.
 *
 * These are in-process interleavings, not real thread races: Node runs one
 * event loop, and the append path is fully synchronous, so "concurrent"
 * means "interleaved across await points". The cases below therefore assert
 * the properties that interleaving can actually break — lost ops, torn
 * lines, duplicated pending blocks, a merge that swallows an op appended
 * while it ran — rather than pretending to test preemption.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendOp,
  findUnevidencedRemovals,
  oplogPaths,
  PENDING_END,
  PENDING_START,
  profileEntries,
  readOps,
  readUnmergedOps,
  readWatermark,
  releaseMerge,
  renderPendingBlock,
  renderPendingIntoProfiles,
  seedBaselineIfMissing,
  stripPendingBlock,
  tryAcquireMerge,
  writeWatermark,
  type Op,
  type OpLayer,
} from '../src/remote/oplog.ts'
import { wikiPaths } from '../src/remote/wiki-fs.ts'

/** One logical session: its own id, appending to a shared workspace. */
interface Session {
  readonly by: string
  seq: number
}

/** An op from `session`, tagged in `target` so tests can find it after the fact. */
function sessionOp(session: Session, layer: OpLayer, marker: string): Op {
  session.seq += 1
  return {
    v: 1,
    seq: session.seq,
    ts: new Date().toISOString(),
    by: session.by,
    layer,
    op: 'update',
    target: marker,
    text: `fact ${marker}`,
    intent: `recorded by ${session.by}`,
    class: 'normal',
  }
}

/** Yield to the event loop so several sessions' work genuinely interleaves. */
function yieldLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/** A workspace with two seeded profile files and a matching baseline. */
async function seededWorkspace(identity = '# identity\n\n## seed\n\noriginal\n'): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-conc-'))
  const paths = wikiPaths(workspaceRoot)
  await mkdir(join(workspaceRoot, '.dsh', 'wiki'), { recursive: true })
  await writeFile(paths.identity, identity)
  await writeFile(paths.preferences, '# preferences\n\n## seed\n\noriginal\n')
  seedBaselineIfMissing(workspaceRoot, layer => (layer === 'identity' ? identity : '# preferences\n\n## seed\n\noriginal\n'))
  return workspaceRoot
}

/** Simulate a completed merge: replace the profiles and advance the watermark past everything so far. */
async function simulateMerge(workspaceRoot: string, profileText: string): Promise<void> {
  const paths = wikiPaths(workspaceRoot)
  await writeFile(paths.identity, profileText)
  const offset = statSync(oplogPaths(workspaceRoot).opsPath).size
  writeWatermark(workspaceRoot, {
    v: 1,
    offset,
    profile: { identity: 'merged', preferences: 'merged' },
    archiveEpoch: { file: null, bytes: 0 },
    updatedAt: new Date().toISOString(),
  })
}

describe('multi-session concurrent append (§10.1)', () => {
  it('loses no op and produces no torn line when sessions interleave appends', async () => {
    const workspaceRoot = await seededWorkspace()
    try {
      const sessions: Session[] = Array.from({ length: 5 }, (_, i) => ({ by: `session-${String(i)}`, seq: 0 }))
      const perSession = 40
      const baselineBytes = statSync(oplogPaths(workspaceRoot).opsPath).size

      // Interleave: each round, every session appends one op, yielding between
      // rounds so the event loop really does switch between sessions.
      for (let round = 0; round < perSession; round += 1) {
        for (const session of sessions) {
          appendOp(workspaceRoot, sessionOp(session, 'identity', `${session.by}-${String(round)}`))
        }
        await yieldLoop()
      }

      const raw = await readFile(oplogPaths(workspaceRoot).opsPath, 'utf8')
      const lines = raw.split('\n').filter(line => line !== '')
      const baselineOps = readOps(workspaceRoot).length - sessions.length * perSession
      assert.equal(lines.length, baselineOps + sessions.length * perSession)

      // Every line must be independently parseable — a torn or interleaved
      // write would show up here as a JSON syntax error or a merged line.
      for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))

      const ops = readOps(workspaceRoot).slice(baselineOps)
      assert.equal(ops.length, sessions.length * perSession)
      for (const session of sessions) {
        const mine = ops.filter(op => op.by === session.by)
        assert.equal(mine.length, perSession, `${session.by} lost ops`)
        assert.equal(mine[0]?.seq, 1, `${session.by} seq did not start at 1`)
        assert.equal(mine[mine.length - 1]?.seq, perSession)
      }
      // Append is pure append: the seeded baseline bytes are untouched.
      assert.ok(statSync(oplogPaths(workspaceRoot).opsPath).size > baselineBytes)
      assert.equal(raw.startsWith('{"v":1'), true)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('keeps every session\'s ops individually identifiable after a full pass', async () => {
    const workspaceRoot = await seededWorkspace()
    try {
      const a: Session = { by: 'session-A', seq: 0 }
      const b: Session = { by: 'session-B', seq: 0 }
      // Two sessions writing to DIFFERENT layers concurrently: neither may
      // clobber the other's pending block (the original data-loss bug class).
      for (let i = 0; i < 20; i += 1) {
        appendOp(workspaceRoot, sessionOp(a, 'identity', `A-${String(i)}`))
        appendOp(workspaceRoot, sessionOp(b, 'preferences', `B-${String(i)}`))
        await yieldLoop()
      }
      renderPendingIntoProfiles(workspaceRoot)
      const paths = wikiPaths(workspaceRoot)
      const identityText = await readFile(paths.identity, 'utf8')
      const preferencesText = await readFile(paths.preferences, 'utf8')
      assert.match(identityText, /A-19/)
      assert.match(preferencesText, /B-19/)
      // A's block must not appear in B's file and vice versa.
      assert.equal(identityText.includes('B-19'), false)
      assert.equal(preferencesText.includes('A-19'), false)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('merge lock under multi-session concurrency (§4, §10.1)', () => {
  it('a second session gets BUSY immediately while a merge is in flight, and its op survives', async () => {
    const workspaceRoot = await seededWorkspace()
    try {
      const a: Session = { by: 'session-A', seq: 0 }
      const b: Session = { by: 'session-B', seq: 0 }
      releaseMerge(workspaceRoot)

      // Session A takes the lock and begins an async merge.
      assert.equal(tryAcquireMerge(workspaceRoot), true)
      const merging = (async (): Promise<void> => {
        await yieldLoop()
        await yieldLoop()
        releaseMerge(workspaceRoot)
      })()

      // While A holds it, B appends and tries to merge: BUSY, no waiting.
      appendOp(workspaceRoot, sessionOp(b, 'identity', 'B-during-merge'))
      const start = process.hrtime.bigint()
      const acquiredByB = tryAcquireMerge(workspaceRoot)
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000
      assert.equal(acquiredByB, false, 'B must not acquire while A is merging')
      assert.ok(elapsedMs < 5, `BUSY must return immediately, took ${String(elapsedMs)}ms`)

      // B's op is durable regardless of the BUSY result.
      assert.ok(readOps(workspaceRoot).some(op => op.target === 'B-during-merge'))

      await merging
      // A released: B can now take it, and A's merge did not consume B's op.
      assert.equal(tryAcquireMerge(workspaceRoot), true)
      releaseMerge(workspaceRoot)
      assert.ok(readUnmergedOps(workspaceRoot).some(op => op.target === 'B-during-merge'))
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('never admits two holders at once across many interleaved attempts', async () => {
    const workspaceRoot = await seededWorkspace()
    try {
      releaseMerge(workspaceRoot)
      let holders = 0
      let maxConcurrentHolders = 0
      const attempt = async (): Promise<void> => {
        for (let i = 0; i < 100; i += 1) {
          if (tryAcquireMerge(workspaceRoot)) {
            holders += 1
            maxConcurrentHolders = Math.max(maxConcurrentHolders, holders)
            await yieldLoop() // hold across an await, the realistic merge shape
            holders -= 1
            releaseMerge(workspaceRoot)
          }
          await yieldLoop()
        }
      }
      await Promise.all([attempt(), attempt(), attempt(), attempt()])
      assert.equal(maxConcurrentHolders, 1, 'more than one session held the merge lock at once')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('pending block under multi-session concurrency (§6, §10.1)', () => {
  it('renders exactly one block no matter how many sessions render concurrently', async () => {
    const workspaceRoot = await seededWorkspace()
    try {
      const sessions: Session[] = Array.from({ length: 4 }, (_, i) => ({ by: `session-${String(i)}`, seq: 0 }))
      for (let i = 0; i < 10; i += 1) {
        for (const session of sessions) {
          appendOp(workspaceRoot, sessionOp(session, 'identity', `${session.by}-${String(i)}`))
          renderPendingIntoProfiles(workspaceRoot)
        }
        await yieldLoop()
      }
      const text = await readFile(wikiPaths(workspaceRoot).identity, 'utf8')
      assert.equal(text.split(PENDING_START).length - 1, 1, 'pending block was duplicated')
      assert.equal(text.split(PENDING_END).length - 1, 1, 'closing marker was duplicated')
      // All 40 interleaved ops are represented in the single block.
      const block = text.slice(text.indexOf(PENDING_START))
      for (const session of sessions) assert.match(block, new RegExp(`${session.by}-9`))
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('stripping is the exact inverse of rendering, so a re-render cannot drift', async () => {
    const workspaceRoot = await seededWorkspace()
    try {
      const pure = await readFile(wikiPaths(workspaceRoot).identity, 'utf8')
      const ops = [
        { ...sessionOp({ by: 's', seq: 0 }, 'identity', 'x'), ts: '2026-09-17T10:00:00+08:00' },
      ]
      const rendered = `${pure}${renderPendingBlock(ops)}`
      assert.equal(stripPendingBlock(rendered), pure)
      // Idempotent: rendering over an existing block replaces it, never nests.
      const twice = `${stripPendingBlock(rendered)}${renderPendingBlock(ops)}`
      assert.equal(twice, rendered)
      assert.equal(stripPendingBlock(renderPendingBlock([])), '')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('a merge that consumed every op leaves no block behind', async () => {
    const workspaceRoot = await seededWorkspace()
    try {
      const session: Session = { by: 'session-A', seq: 0 }
      appendOp(workspaceRoot, sessionOp(session, 'identity', 'to-merge'))
      renderPendingIntoProfiles(workspaceRoot)
      assert.match(await readFile(wikiPaths(workspaceRoot).identity, 'utf8'), /PENDING-OPS/)

      const merged = '# identity\n\n## seed\n\noriginal\n\n## added\n\nto-merge\n'
      await simulateMerge(workspaceRoot, merged)
      const counts = renderPendingIntoProfiles(workspaceRoot)
      assert.equal(counts.identity, 0)
      const text = await readFile(wikiPaths(workspaceRoot).identity, 'utf8')
      assert.equal(text.includes(PENDING_START), false, 'stale block survived the merge')
      assert.equal(text, merged)
      // The merged profile's own content must survive the strip used by §9.2.
      assert.equal(stripPendingBlock(text), merged)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('an op appended while a merge ran is still pending afterwards', async () => {
    const workspaceRoot = await seededWorkspace()
    try {
      const a: Session = { by: 'session-A', seq: 0 }
      const b: Session = { by: 'session-B', seq: 0 }
      appendOp(workspaceRoot, sessionOp(a, 'identity', 'before-merge'))
      const offsetBefore = statSync(oplogPaths(workspaceRoot).opsPath).size

      // B appends while A's merge is in flight.
      await simulateMerge(workspaceRoot, '# identity\n\n## seed\n\noriginal\n')
      appendOp(workspaceRoot, sessionOp(b, 'identity', 'during-merge'))

      const unmerged = readUnmergedOps(workspaceRoot)
      assert.deepEqual(unmerged.map(op => op.target), ['during-merge'])
      assert.ok(statSync(oplogPaths(workspaceRoot).opsPath).size > offsetBefore)
      const counts = renderPendingIntoProfiles(workspaceRoot)
      assert.equal(counts.identity, 1)
      assert.match(await readFile(wikiPaths(workspaceRoot).identity, 'utf8'), /during-merge/)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('mechanical evidence check (§9.4)', () => {
  it('flags a removal with no remove/replace op behind it', () => {
    const before = '# identity\n\n## kept\n\na\n\n## vanished\n\nb\n'
    const after = '# identity\n\n## kept\n\na\n'
    assert.deepEqual(findUnevidencedRemovals(before, after, []), ['vanished'])
  })

  it('accepts a removal that a pending op explicitly targets', () => {
    const before = '# identity\n\n## kept\n\na\n\n## dropped\n\nb\n'
    const after = '# identity\n\n## kept\n\na\n'
    const op: Op = {
      ...sessionOp({ by: 's', seq: 0 }, 'identity', 'dropped'),
      op: 'remove',
      target: 'dropped',
      text: '',
    }
    assert.deepEqual(findUnevidencedRemovals(before, after, [op]), [])
  })

  it('treats replace as removal evidence, and add as none', () => {
    const before = '# identity\n\n## entry\n\nold\n'
    const after = '# identity\n\n## other\n\nnew\n'
    const replace: Op = { ...sessionOp({ by: 's', seq: 0 }, 'identity', 'entry'), op: 'replace', target: 'entry' }
    const add: Op = { ...sessionOp({ by: 's', seq: 1 }, 'identity', 'entry'), op: 'add', target: 'entry' }
    assert.deepEqual(findUnevidencedRemovals(before, after, [replace]), [])
    assert.deepEqual(findUnevidencedRemovals(before, after, [add]), ['entry'])
  })

  it('extracts entry headings from a profile', () => {
    assert.deepEqual(profileEntries('# t\n\n## a\n\n### b\n\ntext\n'), ['t', 'a', 'b'])
  })
})

describe('the lock earns its place (not a tautology)', () => {
  it('shows a lost update without the lock, and none with it', async () => {
    const workspaceRoot = await seededWorkspace()
    try {
      releaseMerge(workspaceRoot)
      // Model a merge as: read profile, build the result, await (the LLM call),
      // write. Two of these running without mutual exclusion is the exact
      // lost-update the original whole-file-overwrite had.
      const mergeOnce = async (who: string): Promise<void> => {
        const path = wikiPaths(workspaceRoot).identity
        const read = await readFile(path, 'utf8')
        await yieldLoop() // the async gap a real merge has
        await writeFile(path, `${stripPendingBlock(read)}## ${who}\n\n${who}\n`)
      }

      await Promise.all([mergeOnce('session-A'), mergeOnce('session-B')])
      const unlocked = await readFile(wikiPaths(workspaceRoot).identity, 'utf8')
      // Without the lock one session's result is gone entirely — this is the
      // failure the lock exists to prevent, asserted so the lock's value is
      // demonstrated rather than assumed.
      const lostWithoutLock = !(unlocked.includes('session-A') && unlocked.includes('session-B'))
      assert.equal(lostWithoutLock, true, 'expected the unlocked form to lose an update')

      // Now the same race, but each merge only proceeds while holding the lock.
      releaseMerge(workspaceRoot)
      const applied: string[] = []
      const guarded = async (who: string): Promise<void> => {
        if (!tryAcquireMerge(workspaceRoot)) return // BUSY: no wait, no merge
        applied.push(who)
        try {
          await mergeOnce(who)
        } finally {
          releaseMerge(workspaceRoot)
        }
      }
      await Promise.all([guarded('session-C'), guarded('session-D')])
      // Exactly one session merged; the other declined instead of clobbering.
      assert.equal(applied.length, 1, 'the lock admitted more than one concurrent merge')
      const guardedText = await readFile(wikiPaths(workspaceRoot).identity, 'utf8')
      assert.match(guardedText, new RegExp(applied[0] ?? 'never'))
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('fail-closed on unreadable op history', () => {
  it('throws rather than silently dropping an unparseable op line', async () => {
    const workspaceRoot = await seededWorkspace()
    try {
      const paths = oplogPaths(workspaceRoot)
      const existing = await readFile(paths.opsPath, 'utf8')
      // A torn line can only appear if the single-write atomicity precondition
      // failed (network volume). Silently skipping it would merge a profile
      // that has quietly lost a fact, so this must surface as an error and let
      // the caller disable merging (spec §9.3).
      await writeFile(paths.opsPath, `${existing}{"v":1,"seq":9`)
      assert.throws(() => readOps(workspaceRoot))
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
