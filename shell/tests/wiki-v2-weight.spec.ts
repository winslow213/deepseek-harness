/**
 * Weight-gated merge triggering (spec §5). The merge decision is a pure
 * function of already-durable state — op `class`, whether an op's target is
 * already consolidated, and whether pending ops contradict each other — so it
 * can gate the critical path without a model call, a clock, or a timer.
 * These cases pin the arithmetic and, more importantly, the two properties
 * that make the gate safe to rely on: a contradictory backlog merges
 * promptly, and a backlog can never grow unbounded.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import {
  appendOp,
  mergeGate,
  oplogPaths,
  pendingWeight,
  releaseMerge,
  tryAcquireMerge,
  readOps,
  seedBaselineIfMissing,
  writeWatermark,
  type Op,
  type OpClass,
  type OpLayer,
} from '../src/remote/oplog.ts'
import { wikiPaths } from '../src/remote/wiki-fs.ts'

/** A workspace whose identity layer already has a consolidated `## seed` entry. */
async function workspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-weight-'))
  const identity = '# identity\n\n## seed\n\nconsolidated\n'
  await mkdir(join(workspaceRoot, '.dsh', 'wiki'), { recursive: true })
  await writeFile(wikiPaths(workspaceRoot).identity, identity)
  await writeFile(wikiPaths(workspaceRoot).preferences, '# preferences\n')
  seedBaselineIfMissing(workspaceRoot, layer => (layer === 'identity' ? identity : '# preferences\na\n'))
  return workspaceRoot
}

/** Append `count` ops against `target`, all of the given class. */
function note(workspaceRoot: string, target: string, count: number, cls: OpClass = 'normal', layer: OpLayer = 'identity'): void {
  for (let i = 0; i < count; i += 1) {
    const op: Op = {
      v: 1,
      seq: i + 1,
      ts: new Date().toISOString(),
      by: `session-${String(i)}`,
      layer,
      op: 'update',
      target,
      text: `text ${String(i)}`,
      intent: 'weight test',
      class: cls,
    }
    appendOp(workspaceRoot, op)
  }
}

describe('pendingWeight state machine', () => {
  it('is idle with nothing unmerged', async () => {
    const workspaceRoot = await workspace()
    try {
      const state = pendingWeight(workspaceRoot)
      assert.equal(state.state, 'idle')
      assert.equal(state.weight, 0)
      assert.equal(state.count, 0)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('accumulates below the threshold instead of merging on every note', async () => {
    const workspaceRoot = await workspace()
    try {
      // The whole point of the gate: several ordinary notes must NOT each
      // trigger a model call the way "merge after every wiki_note" would.
      for (let i = 1; i <= 5; i += 1) {
        note(workspaceRoot, `new-${String(i)}`, 1)
        const state = pendingWeight(workspaceRoot)
        assert.equal(state.state, 'accumulating', `merge triggered after ${String(i)} ordinary notes`)
        assert.equal(state.weight, i)
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('becomes warranted once accumulated weight reaches the threshold', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot, 'a', 1)
      note(workspaceRoot, 'b', 1)
      note(workspaceRoot, 'c', 1)
      note(workspaceRoot, 'd', 1)
      note(workspaceRoot, 'e', 1)
      assert.equal(pendingWeight(workspaceRoot).state, 'accumulating')
      note(workspaceRoot, 'f', 1)
      const state = pendingWeight(workspaceRoot)
      assert.equal(state.state, 'warranted')
      assert.equal(state.weight, 6)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('counts a critical op for more than a normal one', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot, 'a', 1, 'critical')
      note(workspaceRoot, 'b', 1, 'critical')
      // 3 + 3 = 6, warranted with two critical notes where six normal ones are needed.
      assert.equal(pendingWeight(workspaceRoot).weight, 6)
      assert.equal(pendingWeight(workspaceRoot).state, 'warranted')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('weights an op targeting an already-consolidated entry higher, since the profile went stale', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot, 'seed', 1) // 'seed' is a heading in the profile
      assert.equal(pendingWeight(workspaceRoot).weight, 1 + 2)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('merges promptly when pending ops contradict each other', async () => {
    const workspaceRoot = await workspace()
    try {
      // Two ops on one target make the rendered pending block self-contradictory.
      // This is the most urgent signal, so it must reach the threshold on its own.
      note(workspaceRoot, 'same-target', 2)
      const state = pendingWeight(workspaceRoot)
      assert.equal(state.conflicts, 2)
      assert.equal(state.state, 'warranted')
      assert.ok(state.weight > pendingWeight(workspaceRoot, 1_000).weight - 1)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('does not flag distinct targets as conflicting', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot, 'one', 1)
      note(workspaceRoot, 'two', 1)
      assert.equal(pendingWeight(workspaceRoot).conflicts, 0)
      assert.equal(pendingWeight(workspaceRoot).weight, 2)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('counts ops on either layer', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot, 'p', 1, 'normal', 'preferences')
      assert.equal(pendingWeight(workspaceRoot).count, 1)
      assert.equal(pendingWeight(workspaceRoot).weight, 1)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('forces a merge at the pending-op ceiling even when weight stays low', async () => {
    const workspaceRoot = await workspace()
    try {
      // Low-weight ops on distinct targets would otherwise accumulate forever;
      // the ceiling is what stops the pending block growing unbounded.
      note(workspaceRoot, 'x', 40)
      const withCeiling = pendingWeight(workspaceRoot)
      assert.equal(withCeiling.state, 'warranted')
      assert.ok(withCeiling.count >= 40)
      // With the ceiling disabled the same backlog is still merely accumulating,
      // which proves the ceiling (not the weight) is what warranted the merge.
      const noCeiling = pendingWeight(workspaceRoot, 1_000_000, 1_000_000)
      assert.equal(noCeiling.state, 'accumulating')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('honours a configured threshold', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot, 'only', 1)
      assert.equal(pendingWeight(workspaceRoot, 100).state, 'accumulating')
      assert.equal(pendingWeight(workspaceRoot, 1).state, 'warranted')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('returns to idle after a merge consumes the backlog', async () => {
    const workspaceRoot = await workspace()
    try {
      note(workspaceRoot, 'a', 6)
      assert.equal(pendingWeight(workspaceRoot).state, 'warranted')
      // A completed merge advances the watermark past every op written so far.
      writeWatermark(workspaceRoot, {
        v: 1,
        offset: statSync(oplogPaths(workspaceRoot).opsPath).size,
        profile: { identity: 'h', preferences: 'h' },
        archiveEpoch: { file: null, bytes: 0 },
        updatedAt: new Date().toISOString(),
      })
      assert.ok(readOps(workspaceRoot).length > 0)
      assert.equal(pendingWeight(workspaceRoot).state, 'idle')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('mergeGate: the state machine every trigger shares', () => {
  it('skips when idle and does not take the lock', async () => {
    const workspaceRoot = await workspace()
    try {
      releaseMerge(workspaceRoot)
      const decision = mergeGate(workspaceRoot)
      assert.equal(decision.action, 'skip')
      assert.equal(decision.reason, 'idle')
      // Nothing pending must not consume the lock.
      assert.equal(tryAcquireMerge(workspaceRoot), true)
      releaseMerge(workspaceRoot)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('skips below threshold, leaving the lock free', async () => {
    const workspaceRoot = await workspace()
    try {
      releaseMerge(workspaceRoot)
      note(workspaceRoot, 'one', 1)
      const decision = mergeGate(workspaceRoot)
      assert.equal(decision.action, 'skip')
      assert.equal(decision.reason, 'below-threshold')
      assert.equal(tryAcquireMerge(workspaceRoot), true)
      releaseMerge(workspaceRoot)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('hands the lock to the caller once warranted', async () => {
    const workspaceRoot = await workspace()
    try {
      releaseMerge(workspaceRoot)
      note(workspaceRoot, 'a', 6)
      const decision = mergeGate(workspaceRoot)
      assert.equal(decision.action, 'merge')
      // The contract: the caller now owns the lock, so a second evaluation
      // must report busy rather than admit a concurrent merge.
      assert.equal(mergeGate(workspaceRoot).action, 'busy')
      releaseMerge(workspaceRoot)
      assert.equal(mergeGate(workspaceRoot).action, 'merge')
      releaseMerge(workspaceRoot)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('lets the manual tool force a merge below threshold, but not an empty one', async () => {
    const workspaceRoot = await workspace()
    try {
      releaseMerge(workspaceRoot)
      // Model judged it worthwhile despite low weight: allowed.
      note(workspaceRoot, 'one', 1)
      const forced = mergeGate(workspaceRoot, { force: true })
      assert.equal(forced.action, 'merge')
      releaseMerge(workspaceRoot)

      // But forcing with nothing pending is still a no-op (nothing to merge).
      writeWatermark(workspaceRoot, {
        v: 1,
        offset: statSync(oplogPaths(workspaceRoot).opsPath).size,
        profile: { identity: 'h', preferences: 'h' },
        archiveEpoch: { file: null, bytes: 0 },
        updatedAt: new Date().toISOString(),
      })
      assert.equal(mergeGate(workspaceRoot, { force: true }).action, 'skip')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('reports busy immediately rather than waiting for the holder', async () => {
    const workspaceRoot = await workspace()
    try {
      releaseMerge(workspaceRoot)
      note(workspaceRoot, 'a', 6)
      assert.equal(mergeGate(workspaceRoot).action, 'merge') // holds the lock
      const start = process.hrtime.bigint()
      const second = mergeGate(workspaceRoot, { force: true })
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000
      assert.equal(second.action, 'busy')
      assert.ok(elapsedMs < 5, `busy path must not wait, took ${String(elapsedMs)}ms`)
      releaseMerge(workspaceRoot)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
