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
    kind: 'form',
    title: 'Collect details',
    fields: [
      { name: 'name', label: 'Full name', type: 'text', required: true },
      { name: 'reason', label: 'Reason', type: 'select', options: [{ label: 'A', value: 'a' }] },
    ],
    ...over,
  }
}

function validCanvas(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'canvas',
    title: 'Plan a flow',
    nodes: [
      { id: 'start', label: 'Start', role: 'start', position: { x: 0, y: 0 } },
      { id: 'end', label: 'End', role: 'end', position: { x: 200, y: 100 } },
    ],
    edges: [{ id: 'e1', source: 'start', target: 'end', label: 'then' }],
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

  it('accepts a coherent durable canvas surface record', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('session/event', {} as Session, surface('a2ui-2', validCanvas()))
    }).not.toThrow()
  })

  it.each([
    ['empty surfaceId', surface('', validPage()), /surfaceId/],
    ['numeric surfaceId', surface(42, validPage()), /surfaceId/],
    ['page not an object', surface('a2ui-1', 'nope'), /page/],
    ['empty title', surface('a2ui-1', validPage({ title: '   ' })), /title/],
    ['untrimmed title', surface('a2ui-1', validPage({ title: ' x ' })), /already trimmed/],
    ['unknown page kind', surface('a2ui-1', validPage({ kind: 'slides' })), /page\.kind/],
    ['fields not an array', surface('a2ui-1', validPage({ fields: 42 })), /array/],
    ['field not an object', surface('a2ui-1', validPage({ fields: [null] })), /objects/],
    ['empty field name', surface('a2ui-1', validPage({ fields: [{ name: ' ', label: 'A', type: 'text' }] })), /name/],
    ['empty field label', surface('a2ui-1', validPage({ fields: [{ name: 'a', label: '', type: 'text' }] })), /label/],
    ['unknown field type', surface('a2ui-1', validPage({ fields: [{ name: 'a', label: 'A', type: 'radio' }] })), /unknown type/],
    ['select without options', surface('a2ui-1', validPage({ fields: [{ name: 'a', label: 'A', type: 'select' }] })), /at least one option/],
    ['duplicate field names', surface('a2ui-1', validPage({
      fields: [{ name: 'a', label: 'A', type: 'text' }, { name: 'a', label: 'A2', type: 'text' }],
    })), /repeats field name/],
    ['canvas without nodes', surface('a2ui-1', validCanvas({ nodes: [], edges: [] })), /non-empty array/],
    ['canvas duplicate node ids', surface('a2ui-1', validCanvas({
      nodes: [
        { id: 'a', label: 'A', position: { x: 0, y: 0 } },
        { id: 'a', label: 'B', position: { x: 1, y: 1 } },
      ],
      edges: [],
    })), /repeats canvas node id/],
    ['canvas edge to a missing node', surface('a2ui-1', validCanvas({
      nodes: [{ id: 'a', label: 'A', position: { x: 0, y: 0 } }],
      edges: [{ id: 'e1', source: 'a', target: 'nope' }],
    })), /missing node/],
    ['canvas self-loop edge', surface('a2ui-1', validCanvas({
      nodes: [{ id: 'a', label: 'A', position: { x: 0, y: 0 } }],
      edges: [{ id: 'e1', source: 'a', target: 'a' }],
    })), /a node to itself/],
    ['canvas node with non-finite position', surface('a2ui-1', validCanvas({
      nodes: [{ id: 'a', label: 'A', position: { x: Number.NaN, y: 0 } }],
      edges: [],
    })), /finite/],
    ['form page carrying nodes', surface('a2ui-1', validPage({
      nodes: [{ id: 'a', label: 'A', position: { x: 0, y: 0 } }],
    })), /must not carry/],
    ['canvas page carrying fields', surface('a2ui-1', validCanvas({
      fields: [{ name: 'a', label: 'A', type: 'text' }],
    })), /must not carry/],
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
      } as SessionEvent)
    }).not.toThrow()
  })

  it('rejects an invalid existing snapshot on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append('a2ui/surface', {
      surfaceId: 'a2ui-bad',
      page: { kind: 'form', title: 'x', fields: [{ name: 'a', label: 'A', type: 'radio' }] },
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
