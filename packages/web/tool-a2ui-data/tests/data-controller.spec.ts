/** Behavior of the A2UI data-source Remote controller: resolving a source through the composed provider and refusing unknown sources. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { A2uiDataProvider } from '../src/data.ts'
import { A2uiDataController } from '../src/remote.ts'

/** A provider answering a fixed source table. */
function provider(sources: Record<string, { label: string; value: string }[]>): A2uiDataProvider {
  return {
    has: source => source in sources,
    resolve: async source => ({ items: sources[source] ?? [] }),
  }
}

describe('A2uiDataController', () => {
  it('resolves a known source into its options', async () => {
    const ctx = new Context()
    ctx.provide('a2uiData', provider({ 'hdc-devices': [{ label: 'a', value: '1' }] }))
    const controller = new A2uiDataController(ctx)
    await expect(controller.resolve({ source: 'hdc-devices', args: {} }))
      .resolves.toEqual({ items: [{ label: 'a', value: '1' }] })
  })

  it('refuses an unknown source with a caller-facing error', async () => {
    const ctx = new Context()
    ctx.provide('a2uiData', provider({}))
    const controller = new A2uiDataController(ctx)
    await expect(controller.resolve({ source: 'nope', args: {} })).rejects.toMatchObject({
      code: 'a2ui-data/unknown-source',
    })
  })
})
