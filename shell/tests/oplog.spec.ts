/**
 * Wiki v2 oplog foundation: op append/read atomicity (§3, S1), the
 * fail-safe that refuses to merge a profile with no baseline (§9.1, S0),
 * and the in-process merge lock that replaced the mkdir/owner.json
 * cross-process protocol (§4).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendOp,
  assertMergeBaseline,
  checkMergerPid,
  NoBaselineError,
  oplogPaths,
  OpTooLargeError,
  readOps,
  readWatermark,
  recordMergerPid,
  releaseMerge,
  seedBaselineIfMissing,
  tryAcquireMerge,
  writeWatermark,
  type Op,
  type OpLayer,
} from '../src/remote/oplog.ts'

function op(overrides: Partial<Op> = {}): Op {
  return {
    v: 1,
    seq: 1,
    ts: '2026-09-17T12:00:00+08:00',
    by: 'session-test',
    layer: 'identity',
    op: 'update',
    target: '__test__',
    text: 'hello',
    intent: 'testing',
    class: 'normal',
    ...overrides,
  }
}

describe('appendOp / readOps', () => {
  it('writes back byte-identical ops', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      appendOp(workspaceRoot, op({ seq: 1, text: 'one' }))
      appendOp(workspaceRoot, op({ seq: 2, text: 'two' }))
      appendOp(workspaceRoot, op({ seq: 3, text: 'three' }))
      const ops = readOps(workspaceRoot)
      assert.equal(ops.length, 3)
      assert.deepEqual(ops.map(o => o.text), ['one', 'two', 'three'])
      assert.deepEqual(ops[0], op({ seq: 1, text: 'one' }))
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects an oversized op and leaves the file untouched', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      appendOp(workspaceRoot, op({ seq: 1, text: 'kept' }))
      const before = statSync(oplogPaths(workspaceRoot).opsPath).size
      assert.throws(
        () => appendOp(workspaceRoot, op({ seq: 2, text: 'x'.repeat(5000) })),
        OpTooLargeError,
      )
      const after = statSync(oplogPaths(workspaceRoot).opsPath).size
      assert.equal(after, before)
      assert.deepEqual(readOps(workspaceRoot).map(o => o.text), ['kept'])
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('reads an empty array when no ops.jsonl exists yet', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      assert.deepEqual(readOps(workspaceRoot), [])
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('watermark', () => {
  it('round-trips through atomic temp-file-then-rename', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      assert.equal(readWatermark(workspaceRoot), undefined)
      writeWatermark(workspaceRoot, {
        v: 1,
        offset: 42,
        profile: { identity: 'abc', preferences: 'def' },
        archiveEpoch: { file: null, bytes: 0 },
        updatedAt: '2026-09-17T12:00:00+08:00',
      })
      const watermark = readWatermark(workspaceRoot)
      assert.equal(watermark?.offset, 42)
      assert.equal(watermark?.profile.identity, 'abc')
      // No leftover .tmp-* file after the rename.
      const files = await readdir(oplogPaths(workspaceRoot).dir)
      assert.ok(!files.some(f => f.includes('.tmp-')))
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('assertMergeBaseline (S0 fail-safe)', () => {
  it('refuses to merge when the profile is non-empty but ops.jsonl is missing', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      assert.throws(() => assertMergeBaseline(workspaceRoot, true), NoBaselineError)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('refuses to merge when ops.jsonl exists but is empty', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      await mkdir(oplogPaths(workspaceRoot).dir, { recursive: true })
      await writeFile(oplogPaths(workspaceRoot).opsPath, '')
      assert.throws(() => assertMergeBaseline(workspaceRoot, true), NoBaselineError)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('allows merging when the profile is empty regardless of oplog state', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      assert.doesNotThrow(() => assertMergeBaseline(workspaceRoot, false))
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('allows merging when both a profile and a non-empty oplog exist', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      appendOp(workspaceRoot, op())
      assert.doesNotThrow(() => assertMergeBaseline(workspaceRoot, true))
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('in-process merge lock (§4)', () => {
  it('only one of two concurrent tryAcquireMerge calls succeeds', () => {
    const workspaceRoot = '/fake/workspace/lock-test-a'
    releaseMerge(workspaceRoot) // Clean slate regardless of test order.
    try {
      assert.equal(tryAcquireMerge(workspaceRoot), true)
      assert.equal(tryAcquireMerge(workspaceRoot), false)
      assert.equal(tryAcquireMerge(workspaceRoot), false)
    } finally {
      releaseMerge(workspaceRoot)
    }
  })

  it('a released lock can be immediately re-acquired', () => {
    const workspaceRoot = '/fake/workspace/lock-test-b'
    releaseMerge(workspaceRoot)
    try {
      assert.equal(tryAcquireMerge(workspaceRoot), true)
      releaseMerge(workspaceRoot)
      assert.equal(tryAcquireMerge(workspaceRoot), true)
    } finally {
      releaseMerge(workspaceRoot)
    }
  })

  it('locks are independent per workspace root', () => {
    const a = '/fake/workspace/lock-test-c'
    const b = '/fake/workspace/lock-test-d'
    releaseMerge(a)
    releaseMerge(b)
    try {
      assert.equal(tryAcquireMerge(a), true)
      assert.equal(tryAcquireMerge(b), true)
    } finally {
      releaseMerge(a)
      releaseMerge(b)
    }
  })

  it('the BUSY path returns synchronously with no sleep', () => {
    const workspaceRoot = '/fake/workspace/lock-test-e'
    releaseMerge(workspaceRoot)
    try {
      tryAcquireMerge(workspaceRoot)
      const start = process.hrtime.bigint()
      const acquired = tryAcquireMerge(workspaceRoot)
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000
      assert.equal(acquired, false)
      assert.ok(elapsedMs < 5, `BUSY path took ${String(elapsedMs)}ms — expected a synchronous return`)
    } finally {
      releaseMerge(workspaceRoot)
    }
  })
})

describe('checkMergerPid (non-blocking sanity check)', () => {
  it('does not warn when no breadcrumb exists yet', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      let warned = false
      checkMergerPid(workspaceRoot, () => { warned = true })
      assert.equal(warned, false)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('does not warn when the breadcrumb is this same process', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      recordMergerPid(workspaceRoot)
      let warned = false
      checkMergerPid(workspaceRoot, () => { warned = true })
      assert.equal(warned, false)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('warns (but does not throw) when a different, recent pid merged this workspace', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      await mkdir(oplogPaths(workspaceRoot).dir, { recursive: true })
      await writeFile(
        oplogPaths(workspaceRoot).claimSanityPath,
        JSON.stringify({ pid: process.pid + 1, at: Date.now() }),
      )
      let warned = false
      assert.doesNotThrow(() => checkMergerPid(workspaceRoot, () => { warned = true }))
      assert.equal(warned, true)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('does not warn when the foreign pid record is stale', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      await mkdir(oplogPaths(workspaceRoot).dir, { recursive: true })
      await writeFile(
        oplogPaths(workspaceRoot).claimSanityPath,
        JSON.stringify({ pid: process.pid + 1, at: Date.now() - 200_000 }),
      )
      let warned = false
      checkMergerPid(workspaceRoot, () => { warned = true })
      assert.equal(warned, false)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('seedBaselineIfMissing (one path for new and pre-existing accounts)', () => {
  /** A reader over a fixed layer-content map, standing in for `readWikiLayer`. */
  function readerFrom(content: Partial<Record<OpLayer, string>>): (layer: OpLayer) => string {
    return layer => content[layer] ?? ''
  }

  it('seeds a baseline op and watermark from existing profile content', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      const seeded = seedBaselineIfMissing(
        workspaceRoot,
        readerFrom({ identity: '# identity\nfact', preferences: '# prefs\nstyle' }),
      )
      assert.equal(seeded, true)
      const ops = readOps(workspaceRoot)
      assert.equal(ops.length, 2)
      assert.deepEqual(ops.map(o => o.layer), ['identity', 'preferences'])
      assert.ok(ops.every(o => o.op === 'baseline' && o.target === '__baseline__'))
      assert.equal(ops[0]?.text, '# identity\nfact')

      // The fail-safe now passes for this workspace: content plus history.
      assert.doesNotThrow(() => assertMergeBaseline(workspaceRoot, true))
      const watermark = readWatermark(workspaceRoot)
      assert.equal(watermark?.offset, statSync(oplogPaths(workspaceRoot).opsPath).size)
      assert.ok(watermark !== undefined && watermark.profile.identity.length === 64)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('is idempotent: a second call leaves an existing oplog untouched', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      const read = readerFrom({ identity: 'first' })
      assert.equal(seedBaselineIfMissing(workspaceRoot, read), true)
      const before = statSync(oplogPaths(workspaceRoot).opsPath).size
      // Simulate a restart where the profile has since evolved: seeding must
      // NOT re-baseline, or every restart would append a duplicate history.
      assert.equal(seedBaselineIfMissing(workspaceRoot, readerFrom({ identity: 'second' })), false)
      assert.equal(statSync(oplogPaths(workspaceRoot).opsPath).size, before)
      assert.equal(readOps(workspaceRoot)[0]?.text, 'first')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('seeds nothing when both layers are empty (the fail-safe already passes)', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      assert.equal(seedBaselineIfMissing(workspaceRoot, readerFrom({})), false)
      assert.equal(existsSync(oplogPaths(workspaceRoot).opsPath), false)
      assert.doesNotThrow(() => assertMergeBaseline(workspaceRoot, false))
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rewrites a zero-byte leftover from a crashed seed', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      const paths = oplogPaths(workspaceRoot)
      await mkdir(paths.dir, { recursive: true })
      await writeFile(paths.opsPath, '')
      assert.equal(seedBaselineIfMissing(workspaceRoot, readerFrom({ identity: 'recovered' })), true)
      assert.equal(readOps(workspaceRoot)[0]?.text, 'recovered')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('seeds only the layers that have content', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      assert.equal(seedBaselineIfMissing(workspaceRoot, readerFrom({ preferences: 'only prefs' })), true)
      const ops = readOps(workspaceRoot)
      assert.deepEqual(ops.map(o => o.layer), ['preferences'])
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('baseline size carve-out', () => {
  it('seeds a baseline larger than the appendOp bound, while appendOp still rejects one', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      // A realistic profile layer blows past 4 KiB (production identity
      // layers do), and the baseline must carry the whole text so the layer
      // stays rebuildable from history. If this ever starts going through
      // appendOp, it throws here instead of silently failing to migrate
      // every real account.
      const bigProfile = `# identity\n${'fact about the user\n'.repeat(400)}`
      assert.ok(Buffer.byteLength(bigProfile, 'utf8') > 4096)
      assert.equal(seedBaselineIfMissing(workspaceRoot, layer => (layer === 'identity' ? bigProfile : '')), true)
      const ops = readOps(workspaceRoot)
      assert.equal(ops.length, 1)
      assert.equal(ops[0]?.text, bigProfile)
      assert.doesNotThrow(() => assertMergeBaseline(workspaceRoot, true))

      // The concurrent-append bound still applies where it exists for a reason.
      const other = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
      try {
        assert.throws(() => appendOp(other, op({ text: bigProfile })), OpTooLargeError)
      } finally {
        await rm(other, { recursive: true, force: true })
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('fail-safe vs rotation (§7 / §9.1 interaction)', () => {
  /** Simulate a completed rotation: current file empty, history moved to an archive. */
  async function rotate(workspaceRoot: string, archivedContent: string): Promise<void> {
    const paths = oplogPaths(workspaceRoot)
    await mkdir(paths.archiveDir, { recursive: true })
    await writeFile(join(paths.archiveDir, 'ops-202609-001.jsonl'), archivedContent)
    await writeFile(paths.opsPath, '')
  }

  it('does not block a merge when history has rotated into an archive', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      // Just-rotated state: current ops.jsonl empty, profile non-empty.
      // History is safe in the archive, so this must NOT be read as a lost oplog.
      await rotate(workspaceRoot, `${JSON.stringify(op({ op: 'baseline', target: '__baseline__' }))}\n`)
      assert.doesNotThrow(() => assertMergeBaseline(workspaceRoot, true))
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('still blocks when the archive directory exists but holds no non-empty ops file', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      const paths = oplogPaths(workspaceRoot)
      await mkdir(paths.archiveDir, { recursive: true })
      await writeFile(join(paths.archiveDir, 'ops-202609-001.jsonl'), '')
      await writeFile(join(paths.archiveDir, 'README.txt'), 'not an ops file')
      assert.throws(() => assertMergeBaseline(workspaceRoot, true), NoBaselineError)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('counts an archive even when no current ops.jsonl exists at all', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      const paths = oplogPaths(workspaceRoot)
      await mkdir(paths.archiveDir, { recursive: true })
      await writeFile(join(paths.archiveDir, 'ops-202609-001.jsonl'), `${JSON.stringify(op())}\n`)
      assert.doesNotThrow(() => assertMergeBaseline(workspaceRoot, true))
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('unique archival names keep two same-month rotations as separate files', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      const paths = oplogPaths(workspaceRoot)
      await mkdir(paths.archiveDir, { recursive: true })
      // §7 requires unique per-rotation names precisely so this stays true:
      // a rename onto a month-keyed name would replace the first archive (and
      // with it the baseline op) instead of adding a second file.
      await writeFile(join(paths.archiveDir, 'ops-202609-001.jsonl'), 'first\n')
      await writeFile(join(paths.archiveDir, 'ops-202609-002.jsonl'), 'second\n')
      const files = (await readdir(paths.archiveDir)).sort()
      assert.deepEqual(files, ['ops-202609-001.jsonl', 'ops-202609-002.jsonl'])
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
