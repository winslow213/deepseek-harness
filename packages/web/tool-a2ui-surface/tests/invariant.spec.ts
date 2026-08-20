import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { A2uiSurfaceData } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import * as A2uiInvariant from '@deepseek-ai/dsh-tool-a2ui-surface/invariant'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(A2uiInvariant)
  return ctx
}

function surface(surfaceId: unknown, page: unknown): SessionEvent {
  return { type: 'a2ui/surface', seq: 0, time: 0, data: { surfaceId, page } } as SessionEvent
}

function validPage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Collect details',
    fields: [
      { name: 'name', label: 'Full name', type: 'text', required: true },
      { name: 'reason', label: 'Reason', type: 'select', options: [{ label: 'A', value: 'a' }] },
    ],
    ...over,
  }
}

describe('a2ui surface invariants', () => {
  it('accepts a coherent durable surface record', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('session/event', {} as Session, surface('a2ui-1', validPage()))
    }).not.toThrow()
  })

  it.each([
    ['empty surfaceId', surface('', validPage()), /surfaceId/],
    ['numeric surfaceId', surface(42, validPage()), /surfaceId/],
    ['page not an object', surface('a2ui-1', 'nope'), /page/],
    ['empty title', surface('a2ui-1', validPage({ title: '   ' })), /title/],
    ['untrimmed title', surface('a2ui-1', validPage({ title: ' x ' })), /already trimmed/],
    ['fields not an array', surface('a2ui-1', validPage({ fields: 42 })), /array/],
    ['field not an object', surface('a2ui-1', { title: 'x', fields: [null] }), /objects/],
    ['empty field name', surface('a2ui-1', { title: 'x', fields: [{ name: ' ', label: 'A', type: 'text' }] }), /name/],
    ['empty field label', surface('a2ui-1', { title: 'x', fields: [{ name: 'a', label: '', type: 'text' }] }), /label/],
    ['unknown field type', surface('a2ui-1', { title: 'x', fields: [{ name: 'a', label: 'A', type: 'radio' }] }), /unknown type/],
    ['select without options', surface('a2ui-1', { title: 'x', fields: [{ name: 'a', label: 'A', type: 'select' }] }), /at least one option/],
    ['duplicate field names', surface('a2ui-1', {
      title: 'x',
      fields: [{ name: 'a', label: 'A', type: 'text' }, { name: 'a', label: 'A2', type: 'text' }],
    }), /repeats field name/],
  ])('rejects an incoherent durable surface record (%s)', async (_label, event, message) => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, event) }).toThrow(message)
  })

  it('ignores unrelated dispatches and session events', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('tools/change')
      ctx.emit('session/event', {} as Session, {
        type: 'turn/start', seq: 0, time: 0, data: { turn: 1 },
      })
    }).not.toThrow()
  })

  it('rejects an invalid existing snapshot on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append('a2ui/surface', {
      surfaceId: 'a2ui-bad',
      page: { title: 'x', fields: [{ name: 'a', label: 'A', type: 'radio' }] },
    } as unknown as A2uiSurfaceData)
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(A2uiInvariant).then(() => undefined)).rejects.toThrow(/unknown type/)
  })

  it('accepts repeated surfaceId updates (open then replace is a valid log)', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('session/event', {} as Session, surface('a2ui-fixed', validPage({ title: 'V1' })))
      ctx.emit('session/event', {} as Session, surface('a2ui-fixed', validPage({ title: 'V2' })))
    }).not.toThrow()
  })
})
