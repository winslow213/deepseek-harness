/**
 * The model wiring in `wiki-merge.ts`: target resolution, output unwrapping,
 * rotation pass-through, and — most importantly — that the automatic trigger
 * is genuinely fire-and-forget. Tested with a stub context because the real
 * `llm` service needs a provider; what matters here is the contract around the
 * call, not the call itself.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendOp, oplogPaths, readUnmergedOps, releaseMerge, seedBaselineIfMissing, tryAcquireMerge, type Op } from '../src/remote/oplog.ts'
import { wikiPaths } from '../src/remote/wiki-fs.ts'

/**
 * Load `wiki-merge.ts` with its `@deepseek-ai/*` imports stubbed out. The real
 * modules only resolve inside a dsh instance (the same reason `shell/`'s
 * standalone tsconfig excludes this file), so the unit under test is exercised
 * against minimal fakes while the logic that runs in production is unchanged.
 */
async function loadWikiMerge(): Promise<{
  createLlmCompletion: (ctx: unknown, agent: unknown) => ((p: string, l: string) => Promise<string>) | undefined
  maybeRotate: (workspaceRoot: string, options?: { rotateBytes?: number }) => boolean
  scheduleMerge: (ctx: unknown, agent: unknown, workspaceRoot: string, options?: Record<string, unknown>) => void
  runMerge: (ctx: unknown, agent: unknown, workspaceRoot: string, options?: Record<string, unknown>) => Promise<{ merged: boolean; reason?: string }>
}> {
  // Direct import: `shell/`'s tsx loader resolves these through the repo's
  // node_modules, which is present for tests even though the standalone build
  // excludes the file.
  return await import('../src/remote/wiki-merge.ts') as never
}

/** A workspace with profile files and a seeded baseline. */
async function workspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-wiki-wire-'))
  const identity = '# identity\n\n## seed\n\noriginal\n'
  await mkdir(join(workspaceRoot, '.dsh', 'wiki'), { recursive: true })
  await writeFile(wikiPaths(workspaceRoot).identity, identity)
  await writeFile(wikiPaths(workspaceRoot).preferences, '# preferences\n')
  seedBaselineIfMissing(workspaceRoot, layer => (layer === 'identity' ? identity : '# preferences\n'))
  releaseMerge(workspaceRoot)
  return workspaceRoot
}

/**
 * Pending ops that put the accumulated weight over the default threshold.
 * Two `critical` ops weigh 3 each, so the total is 6 — the documented
 * threshold. One is deliberately not enough, so a test using this helper is
 * exercising the automatic trigger rather than the manual force path.
 */
function heavyNote(workspaceRoot: string): void {
  for (const target of ['x', 'y']) {
    appendOp(workspaceRoot, {
      v: 1, seq: 1, ts: new Date().toISOString(), by: 'session-A', layer: 'identity',
      op: 'update', target, text: `fact ${target}`, intent: 'wire test', class: 'critical',
    } satisfies Op)
  }
}

/** A stub agent whose session names a provider/model, plus its recorded request header. */
function stubAgent(header?: { provider: string; model: string }): unknown {
  return {
    session: { id: 'session-A', requestHeader: () => (header === undefined ? undefined : { config: header }) },
    options: {},
  }
}

/**
 * A stub context capturing logs and serving a canned stream. The chunks are
 * real `text-delta` stream events, because `BlockAssembler` switches on the
 * chunk discriminant and rejects anything else outright.
 */
function stubCtx(chunks: string[] = []): { ctx: unknown; logs: string[] } {
  const logs: string[] = []
  return {
    logs,
    ctx: {
      logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
      llm: {
        stream: () => (async function* generate() {
          for (const text of chunks) yield { type: 'text-delta', index: 0, text }
          yield { type: 'finish', reason: 'stop', replayState: undefined }
        })(),
      },
    },
  }
}

describe('createLlmCompletion', () => {
  it('resolves the target from the session header and returns a completion', async () => {
    const { createLlmCompletion } = await loadWikiMerge()
    const { ctx } = stubCtx(['# merged\n'])
    const complete = createLlmCompletion(ctx, stubAgent({ provider: 'p', model: 'm' }))
    assert.notEqual(complete, undefined)
    assert.equal(await complete?.('prompt', 'identity'), '# merged')
  })

  it('returns undefined when no provider/model can be resolved', async () => {
    const { createLlmCompletion } = await loadWikiMerge()
    const { ctx } = stubCtx(['# merged\n'])
    assert.equal(createLlmCompletion(ctx, stubAgent()), undefined)
  })

  it('falls back to the agent options when the session has not routed yet', async () => {
    const { createLlmCompletion } = await loadWikiMerge()
    const { ctx } = stubCtx(['# from options\n'])
    const agent = { session: { id: 's', requestHeader: () => undefined }, options: { provider: 'p', model: 'm' } }
    assert.equal(await createLlmCompletion(ctx, agent)?.('p', 'identity'), '# from options')
  })

  it('strips a tagged wrapper and a code fence from the completion', async () => {
    const { createLlmCompletion } = await loadWikiMerge()
    const tagged = stubCtx(['noise <wiki-profile>\n## real\ncontent\n</wiki-profile> trailing'])
    assert.equal(await createLlmCompletion(tagged.ctx, stubAgent({ provider: 'p', model: 'm' }))?.('p', 'identity'), '## real\ncontent')

    const fenced = stubCtx(['```markdown\n## fenced\nbody\n```'])
    assert.equal(await createLlmCompletion(fenced.ctx, stubAgent({ provider: 'p', model: 'm' }))?.('p', 'identity'), '## fenced\nbody')
  })

  it('throws when the completion produced no text, so the merge refuses rather than writing nothing', async () => {
    const { createLlmCompletion } = await loadWikiMerge()
    const { ctx } = stubCtx([''])
    await assert.rejects(
      async () => createLlmCompletion(ctx, stubAgent({ provider: 'p', model: 'm' }))?.('p', 'identity'),
      /no text/,
    )
  })
})

describe('maybeRotate', () => {
  it('rotates past the threshold and does not below it', async () => {
    const { maybeRotate } = await loadWikiMerge()
    const workspaceRoot = await workspace()
    try {
      assert.equal(maybeRotate(workspaceRoot, { rotateBytes: 1 }), true)
      assert.equal(maybeRotate(workspaceRoot, { rotateBytes: 1 }), false)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('scheduleMerge is fire-and-forget (spec §5.3)', () => {
  it('returns without awaiting the merge, but the merge still runs', async () => {
    const { scheduleMerge } = await loadWikiMerge()
    const workspaceRoot = await workspace()
    try {
      heavyNote(workspaceRoot)
      const { ctx, logs } = stubCtx(['# identity\n\n## seed\n\noriginal\n\n## x\n\na fact\n'])
      const start = process.hrtime.bigint()
      scheduleMerge(ctx, stubAgent({ provider: 'p', model: 'm' }), workspaceRoot)
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000
      // The call itself must not block on the model: it is a scheduling call.
      assert.ok(elapsedMs < 20, `scheduleMerge blocked for ${String(elapsedMs)}ms`)
      // Let the detached promise settle, then confirm it actually merged.
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(readUnmergedOps(workspaceRoot).length, 0, 'the detached merge did not run')
      assert.ok(logs.some(line => line.includes('folded')), `expected a merge log, got ${JSON.stringify(logs)}`)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('swallows a failing merge instead of surfacing an unhandled rejection', async () => {
    const { scheduleMerge } = await loadWikiMerge()
    const workspaceRoot = await workspace()
    try {
      heavyNote(workspaceRoot)
      const { ctx, logs } = stubCtx([]) // empty stream -> the completion throws
      scheduleMerge(ctx, stubAgent({ provider: 'p', model: 'm' }), workspaceRoot)
      await new Promise(resolve => setTimeout(resolve, 50))
      // The ops survive, the lock is free, and the failure was logged, not thrown.
      assert.equal(readUnmergedOps(workspaceRoot).length, 2)
      assert.equal(tryAcquireMerge(workspaceRoot), true)
      releaseMerge(workspaceRoot)
      assert.ok(logs.some(line => line.includes('failed')), `expected a failure log, got ${JSON.stringify(logs)}`)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

describe('runMerge (the manual path)', () => {
  it('merges even below the weight threshold, because the model asked', async () => {
    const { runMerge } = await loadWikiMerge()
    const workspaceRoot = await workspace()
    try {
      // One ordinary op: nowhere near the default threshold of 6.
      appendOp(workspaceRoot, {
        v: 1, seq: 1, ts: new Date().toISOString(), by: 's', layer: 'identity',
        op: 'update', target: 'light', text: 'small fact', intent: 'manual', class: 'normal',
      } satisfies Op)
      const { ctx } = stubCtx(['# identity\n\n## seed\n\noriginal\n\n## light\n\nsmall fact\n'])
      const outcome = await runMerge(ctx, stubAgent({ provider: 'p', model: 'm' }), workspaceRoot, { force: true })
      assert.equal(outcome.merged, true)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('reports no-model rather than attempting a merge with an unknown target', async () => {
    const { runMerge } = await loadWikiMerge()
    const workspaceRoot = await workspace()
    try {
      heavyNote(workspaceRoot)
      const { ctx } = stubCtx(['# whatever\n'])
      const outcome = await runMerge(ctx, stubAgent(), workspaceRoot, { force: true })
      assert.equal(outcome.merged, false)
      assert.equal(outcome.reason, 'no-model')
      // Nothing was written and no lock leaked.
      assert.equal(readUnmergedOps(workspaceRoot).length, 2)
      assert.equal(existsSync(oplogPaths(workspaceRoot).opsPath), true)
      assert.equal(tryAcquireMerge(workspaceRoot), true)
      releaseMerge(workspaceRoot)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('honours a threshold override from configuration', async () => {
    const { runMerge } = await loadWikiMerge()
    const workspaceRoot = await workspace()
    try {
      appendOp(workspaceRoot, {
        v: 1, seq: 1, ts: new Date().toISOString(), by: 's', layer: 'identity',
        op: 'update', target: 'light', text: 'small fact', intent: 'cfg', class: 'normal',
      } satisfies Op)
      const { ctx } = stubCtx(['# identity\n\n## seed\n\noriginal\n\n## light\n\nsmall fact\n'])
      // Without force, a threshold of 1 makes the single light op sufficient.
      const outcome = await runMerge(ctx, stubAgent({ provider: 'p', model: 'm' }), workspaceRoot, { threshold: 1 })
      assert.equal(outcome.merged, true)
      assert.ok(statSync(oplogPaths(workspaceRoot).opsPath).size > 0)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
