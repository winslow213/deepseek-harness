/**
 * Rotation (spec §7, slice S5) and full-history collection. Rotation is the
 * one place where getting the bookkeeping subtly wrong is invisible until
 * later — a replaced archive or a mis-recorded `archiveEpoch` still leaves a
 * working system with a quietly unrecoverable history — so these cases pin
 * the file naming, the watermark reset, and the rebuild path.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendOp,
  assertMergeBaseline,
  collectAllOps,
  oplogPaths,
  readOps,
  readWatermark,
  rotateIfNeeded,
  seedBaselineIfMissing,
  type Op,
} from '../src/remote/oplog.ts'
import { wikiPaths } from '../src/remote/wiki-fs.ts'

/** A seeded workspace with a handful of unmerged ops appended. */
async function workspaceWithOps(count: number): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-rot-'))
  const identity = '# identity\n\n## seed\n\noriginal\n'
  await mkdir(join(workspaceRoot, '.dsh', 'wiki'), { recursive: true })
  await writeFile(wikiPaths(workspaceRoot).identity, identity)
  await writeFile(wikiPaths(workspaceRoot).preferences, '# preferences\n')
  seedBaselineIfMissing(workspaceRoot, layer => (layer === 'identity' ? identity : '# preferences\n'))
  for (let i = 0; i < count; i += 1) {
    appendOp(workspaceRoot, {
      v: 1,
      seq: i + 1,
      ts: new Date().toISOString(),
      by: `session-${String(i)}`,
      layer: 'identity',
      op: 'update',
      target: `t-${String(i)}`,
      text: `fact ${String(i)}`,
      intent: 'rotation test',
      class: 'normal',
    })
  }
  return workspaceRoot
}

/** The ops a rotation is expected to have moved into the archive. */
function opsIn(file: string): Op[] {
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Op)
}

describe('rotateIfNeeded (§7, S5)', () => {
  it('does nothing while the file is at or below the threshold', async () => {
    const workspaceRoot = await workspaceWithOps(3)
    try {
      const size = statSync(oplogPaths(workspaceRoot).opsPath).size
      const offsetBefore = readWatermark(workspaceRoot)?.offset
      const result = rotateIfNeeded(workspaceRoot, size)
      assert.equal(result.rotated, false)
      assert.equal(readOps(workspaceRoot).length, 5) // two baseline ops (one per layer) + 3
      // A non-rotation must leave the merge watermark exactly where it was
      // (offset tracks merged bytes, so it is below the file size here).
      assert.equal(readWatermark(workspaceRoot)?.offset, offsetBefore)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('archives the whole file, empties the current one, and resets the offset', async () => {
    const workspaceRoot = await workspaceWithOps(3)
    try {
      const before = readOps(workspaceRoot)
      const beforeSize = statSync(oplogPaths(workspaceRoot).opsPath).size
      const result = rotateIfNeeded(workspaceRoot, 1) // force
      assert.equal(result.rotated, true)
      assert.equal(result.bytes, beforeSize)

      // All history is in the archive, intact and in order.
      const archived = opsIn(join(oplogPaths(workspaceRoot).archiveDir, result.archiveFile ?? ''))
      assert.deepEqual(archived, before)

      // The current file is gone (or empty), and the offset points at it.
      const watermark = readWatermark(workspaceRoot)
      assert.equal(watermark?.offset, 0)
      if (existsSync(oplogPaths(workspaceRoot).opsPath)) {
        assert.equal(statSync(oplogPaths(workspaceRoot).opsPath).size, 0)
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('records THIS rotation\'s file and bytes in archiveEpoch, not a running total', async () => {
    const workspaceRoot = await workspaceWithOps(2)
    try {
      const firstSize = statSync(oplogPaths(workspaceRoot).opsPath).size
      const first = rotateIfNeeded(workspaceRoot, 1, new Date('2026-09-17T00:00:00Z'))
      assert.equal(readWatermark(workspaceRoot)?.archiveEpoch.file, first.archiveFile)
      assert.equal(readWatermark(workspaceRoot)?.archiveEpoch.bytes, firstSize)

      // A second rotation must describe the second archive, not sum both.
      appendOp(workspaceRoot, {
        v: 1, seq: 1, ts: new Date().toISOString(), by: 's', layer: 'identity',
        op: 'update', target: 'later', text: 'x', intent: 'second rotation', class: 'normal',
      })
      const secondSize = statSync(oplogPaths(workspaceRoot).opsPath).size
      const second = rotateIfNeeded(workspaceRoot, 1, new Date('2026-09-17T00:00:00Z'))
      const watermark = readWatermark(workspaceRoot)
      assert.equal(watermark?.archiveEpoch.file, second.archiveFile)
      assert.equal(watermark?.archiveEpoch.bytes, secondSize)
      assert.ok(
        (watermark?.archiveEpoch.bytes ?? 0) < firstSize + secondSize,
        'archiveEpoch.bytes looks like a cumulative total, which would exceed the named file',
      )
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('never replaces an earlier archive when rotating twice in one month', async () => {
    const workspaceRoot = await workspaceWithOps(2)
    try {
      const first = rotateIfNeeded(workspaceRoot, 1, new Date('2026-09-01T00:00:00Z'))
      const firstContents = await readFile(join(oplogPaths(workspaceRoot).archiveDir, first.archiveFile ?? ''), 'utf8')

      appendOp(workspaceRoot, {
        v: 1, seq: 1, ts: new Date().toISOString(), by: 's', layer: 'identity',
        op: 'update', target: 'second', text: 'y', intent: 'same month', class: 'normal',
      })
      const second = rotateIfNeeded(workspaceRoot, 1, new Date('2026-09-28T00:00:00Z'))

      assert.notEqual(first.archiveFile, second.archiveFile, 'same-month rotations reused a filename')
      const files = (await readdir(oplogPaths(workspaceRoot).archiveDir)).sort()
      assert.equal(files.length, 2)
      // The first archive still holds the baseline, byte for byte.
      assert.equal(
        await readFile(join(oplogPaths(workspaceRoot).archiveDir, first.archiveFile ?? ''), 'utf8'),
        firstContents,
      )
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('keeps the fail-safe satisfied right after a rotation (empty file, non-empty profile)', async () => {
    const workspaceRoot = await workspaceWithOps(2)
    try {
      rotateIfNeeded(workspaceRoot, 1)
      // This is the state that would be misread as a lost oplog if the
      // fail-safe only looked at the current file.
      assert.doesNotThrow(() => assertMergeBaseline(workspaceRoot, true))
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('leaves the profile hashes untouched, since rotation does not change profiles', async () => {
    const workspaceRoot = await workspaceWithOps(2)
    try {
      const before = readWatermark(workspaceRoot)
      rotateIfNeeded(workspaceRoot, 1)
      assert.deepEqual(readWatermark(workspaceRoot)?.profile, before?.profile)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('collectAllOps (rebuildable history)', () => {
  it('returns archives in order followed by the current file, so nothing is lost across rotations', async () => {
    const workspaceRoot = await workspaceWithOps(2)
    try {
      const original = readOps(workspaceRoot)
      rotateIfNeeded(workspaceRoot, 1, new Date('2026-09-01T00:00:00Z'))
      appendOp(workspaceRoot, {
        v: 1, seq: 1, ts: new Date().toISOString(), by: 'after', layer: 'identity',
        op: 'update', target: 'post-rotation', text: 'z', intent: 'post', class: 'normal',
      })
      const all = collectAllOps(workspaceRoot)
      assert.deepEqual(all.slice(0, original.length), original)
      assert.equal(all[all.length - 1]?.target, 'post-rotation')
      assert.equal(all.length, original.length + 1)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('spans two archives and the live file', async () => {
    const workspaceRoot = await workspaceWithOps(1)
    try {
      rotateIfNeeded(workspaceRoot, 1, new Date('2026-09-01T00:00:00Z'))
      appendOp(workspaceRoot, {
        v: 1, seq: 1, ts: new Date().toISOString(), by: 's', layer: 'identity',
        op: 'update', target: 'second-era', text: 'a', intent: 'x', class: 'normal',
      })
      rotateIfNeeded(workspaceRoot, 1, new Date('2026-09-02T00:00:00Z'))
      appendOp(workspaceRoot, {
        v: 1, seq: 2, ts: new Date().toISOString(), by: 's', layer: 'identity',
        op: 'update', target: 'live', text: 'b', intent: 'y', class: 'normal',
      })
      const targets = collectAllOps(workspaceRoot).map(op => op.target)
      // Two baseline ops: the fixture seeds a non-empty preferences layer too.
      assert.deepEqual(targets, ['__baseline__', '__baseline__', 't-0', 'second-era', 'live'])
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
