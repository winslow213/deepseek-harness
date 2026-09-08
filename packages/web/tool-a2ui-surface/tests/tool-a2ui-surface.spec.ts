import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { type Agent } from '@deepseek-ai/dsh-agent'

import { canonicalizeA2uiPage, type A2uiPageInput } from '../src/index.ts'
import * as tool from '../src/index.ts'
import type { A2uiCanvasPage, A2uiFormPage } from '../src/types.ts'

const testToolSignal = new AbortController().signal

/**
 * Drives the REAL plugin body: mounts `dsh-tool-a2ui-surface` on a real
 * `ToolRuntime` and invokes the registered `a2ui_surface` tool through
 * `ctx.tools.execute`, with a fake parent Agent carrying a real `Session` —
 * so the append the tool makes is observable on a genuine session log (only
 * the agent wrapper is a stand-in; the session and the tool are the shipping
 * code).
 */

/** A parent Agent backed by a real Session — the tool reads `agent.session`. */
function agentWithSession(id = 'parent-1'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

async function setup(allowUpdate = true): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool, { allowUpdate })
  return ctx
}

let callCounter = 0
function callSurface(ctx: Context, args: unknown, over: { agent?: Agent | undefined } = {}) {
  const agent = 'agent' in over ? over.agent : agentWithSession()
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name: 'a2ui_surface',
    arguments: args,
    ...agent ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

function page(over: Record<string, unknown> = {}) {
  return {
    kind: 'form',
    title: 'Collect details',
    fields: [
      { name: 'name', label: 'Full name', type: 'text', required: true },
      { name: 'reason', label: 'Reason', type: 'select', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
    ],
    ...over,
  }
}

function canvasPage(over: Record<string, unknown> = {}) {
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

describe('dsh-tool-a2ui-surface', () => {
  it('registers an `a2ui_surface` tool whose schema carries a page and optional surfaceId', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'a2ui_surface')
    expect(schema).toBeDefined()
    const params = schema!.parameters as { properties?: Record<string, unknown>; required?: string[] }
    const props = params.properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['page', 'surfaceId'])
    expect(params.required).toContain('page')
    expect(params.required).not.toContain('surfaceId')
    const pageSpec = props.page as { type: string; required?: string[]; properties?: Record<string, unknown> }
    expect(pageSpec.type).toBe('object')
    expect(pageSpec.required).toEqual(['kind', 'title'])
    expect(Object.keys(pageSpec.properties ?? {}).sort()).toEqual([
      'actions', 'description', 'edges', 'fields', 'instruction', 'kind', 'nodes', 'submitLabel', 'title',
    ])
    const kindSpec = pageSpec.properties!.kind as { enum?: string[] }
    expect(kindSpec.enum).toEqual(['form', 'canvas'])
    const fieldProps = ((pageSpec.properties!.fields as { items: { properties: Record<string, unknown> } }).items.properties)
    expect(Object.keys(fieldProps).sort()).toEqual(['compute', 'help', 'label', 'name', 'options', 'placeholder', 'required', 'type', 'validateMessage', 'validateWhen', 'visibleWhen'])
    const typeSpec = fieldProps.type as { enum?: string[] }
    expect(typeSpec.enum).toEqual(['text', 'textarea', 'select', 'number', 'checkbox'])
    const nodeSpec = ((pageSpec.properties!.nodes as { items: { properties: Record<string, unknown>; required?: string[] } }).items)
    expect(Object.keys(nodeSpec.properties).sort()).toEqual(['detail', 'id', 'label', 'position', 'role'])
    expect(nodeSpec.required).toEqual(['id', 'label', 'position'])
    const edgeSpec = ((pageSpec.properties!.edges as { items: { properties: Record<string, unknown> } }).items)
    expect(Object.keys(edgeSpec.properties).sort()).toEqual(['id', 'label', 'source', 'target'])
  })

  it('appends an a2ui/surface event carrying the page to the calling session', async () => {
    const ctx = await setup()
    const agent = agentWithSession('writer')
    const result = await callSurface(ctx, { page: page() }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a2ui_surface success')
    const value = result.value as {
      surfaceId: string
      accepted: boolean
      pageKind: string
      fieldCount: number
      nodeCount: number
      edgeCount: number
    }
    expect(value.accepted).toBe(true)
    expect(value.pageKind).toBe('form')
    expect(value.fieldCount).toBe(2)
    expect(value.nodeCount).toBe(0)
    expect(value.edgeCount).toBe(0)
    expect(value.surfaceId).toMatch(/^a2ui-/)
    expect(text(result)).toContain(`Rendered A2UI surface ${value.surfaceId} with 2 fields`)

    const event = agent.session.snapshotEvents().findLast(e => e.type === 'a2ui/surface')!
    expect(event.data.surfaceId).toBe(value.surfaceId)
    expect(event.data.page.title).toBe('Collect details')
    expect(event.data.page.kind).toBe('form')
    expect((event.data.page as A2uiFormPage).fields).toHaveLength(2)
  })

  it('appends an a2ui/canvas event carrying the graph to the calling session', async () => {
    const ctx = await setup()
    const agent = agentWithSession('canvas-writer')
    const result = await callSurface(ctx, { page: canvasPage() }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a2ui_surface success')
    const value = result.value as {
      surfaceId: string
      accepted: boolean
      pageKind: string
      fieldCount: number
      nodeCount: number
      edgeCount: number
    }
    expect(value.accepted).toBe(true)
    expect(value.pageKind).toBe('canvas')
    expect(value.fieldCount).toBe(0)
    expect(value.nodeCount).toBe(2)
    expect(value.edgeCount).toBe(1)
    expect(value.surfaceId).toMatch(/^a2ui-/)
    expect(text(result)).toContain(`Rendered A2UI surface ${value.surfaceId} with 2 nodes and 1 edges`)

    const event = agent.session.snapshotEvents().findLast(e => e.type === 'a2ui/surface')!
    expect(event.data.surfaceId).toBe(value.surfaceId)
    expect(event.data.page.kind).toBe('canvas')
    expect((event.data.page as A2uiCanvasPage).nodes.map(node => node.id)).toEqual(['start', 'end'])
  })

  it('stores trimmed title and field names (the renderer keys), not raw input', async () => {
    const ctx = await setup()
    const agent = agentWithSession('trim')
    const result = await callSurface(ctx, {
      page: {
        kind: 'form',
        title: '  Trim me  ',
        fields: [
          { name: ' a ', label: ' Label A ', type: 'text' },
        ],
      },
    }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a2ui_surface success')

    const event = agent.session.snapshotEvents().findLast(e => e.type === 'a2ui/surface')!
    expect(event.data.page.title).toBe('Trim me')
    const fields = (event.data.page as A2uiFormPage).fields
    expect(fields[0]!.name).toBe('a')
    expect(fields[0]!.label).toBe('Label A')
  })

  it('mints a fresh surfaceId per call when none is supplied', async () => {
    const ctx = await setup()
    const agent = agentWithSession('fresh')
    const first = await callSurface(ctx, { page: page({ title: 'First' }) }, { agent })
    const second = await callSurface(ctx, { page: page({ title: 'Second' }) }, { agent })
    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)
    if (first.isError || second.isError) throw new Error('expected a2ui_surface success')
    expect((first.value as { surfaceId: string }).surfaceId).not.toBe((second.value as { surfaceId: string }).surfaceId)
    expect(agent.session.snapshotEvents().filter(e => e.type === 'a2ui/surface')).toHaveLength(2)
  })

  it('replaces an existing surface when the caller passes a stable surfaceId', async () => {
    const ctx = await setup()
    const agent = agentWithSession('replacer')
    const surfaceId = 'a2ui-fixed'
    await callSurface(ctx, { page: page({ title: 'V1' }), surfaceId }, { agent })
    await callSurface(ctx, { page: page({ title: 'V2' }) }, { agent })
    const surfaces = agent.session.snapshotEvents().filter(e => e.type === 'a2ui/surface')
    expect(surfaces).toHaveLength(2)
    expect(surfaces[0]!.data.surfaceId).toBe(surfaceId)
    expect(surfaces[1]!.data.surfaceId).not.toBe(surfaceId)
  })

  it('rejects a malformed field type before execute runs (registry arg-validation)', async () => {
    const ctx = await setup()
    const result = await callSurface(ctx, {
      page: { kind: 'form', title: 'x', fields: [{ name: 'a', label: 'A', type: 'radio' }] },
    })
    expect(result.isError).toBe(true)
  })

  it('rejects a non-object page argument', async () => {
    const ctx = await setup()
    const result = await callSurface(ctx, { page: 'nope' })
    expect(result.isError).toBe(true)
  })

  it('rejects a page whose fields carry unknown keys (shape must equal the logged page)', async () => {
    const ctx = await setup()
    const result = await callSurface(ctx, {
      page: { kind: 'form', title: 'x', fields: [{ name: 'a', label: 'A', type: 'text', nested: { x: 1 } }] },
    })
    expect(result.isError).toBe(true)
  })

  it.each([
    { label: 'empty title', page: { kind: 'form', title: '   ', fields: [{ name: 'a', label: 'A', type: 'text' }] }, fragment: 'title' },
    { label: 'empty field name', page: { kind: 'form', title: 'x', fields: [{ name: '  ', label: 'A', type: 'text' }] }, fragment: 'non-empty' },
    { label: 'empty field label', page: { kind: 'form', title: 'x', fields: [{ name: 'a', label: ' ', type: 'text' }] }, fragment: 'non-empty' },
    { label: 'duplicate field names', page: { kind: 'form', title: 'x', fields: [{ name: 'a', label: 'A', type: 'text' }, { name: 'a', label: 'A2', type: 'text' }] }, fragment: 'duplicate' },
    { label: 'select without options', page: { kind: 'form', title: 'x', fields: [{ name: 'a', label: 'A', type: 'select' }] }, fragment: 'at least one option' },
    { label: 'canvas with empty node list', page: { kind: 'canvas', title: 'x', nodes: [], edges: [] }, fragment: 'at least one node' },
    { label: 'canvas with duplicate node ids', page: { kind: 'canvas', title: 'x', nodes: [
      { id: 'a', label: 'A', position: { x: 0, y: 0 } }, { id: 'a', label: 'B', position: { x: 1, y: 1 } },
    ], edges: [] }, fragment: 'duplicate node id' },
    { label: 'canvas edge referencing a missing node', page: { kind: 'canvas', title: 'x', nodes: [
      { id: 'a', label: 'A', position: { x: 0, y: 0 } },
    ], edges: [{ id: 'e1', source: 'a', target: 'nope' }] }, fragment: 'does not exist' },
    { label: 'canvas self-loop edge', page: { kind: 'canvas', title: 'x', nodes: [
      { id: 'a', label: 'A', position: { x: 0, y: 0 } },
    ], edges: [{ id: 'e1', source: 'a', target: 'a' }] }, fragment: 'connect to itself' },
    { label: 'form page carrying nodes', page: { kind: 'form', title: 'x', fields: [{ name: 'a', label: 'A', type: 'text' }], nodes: [{ id: 'a', label: 'A', position: { x: 0, y: 0 } }] }, fragment: 'must not carry' },
    { label: 'canvas page carrying fields', page: { kind: 'canvas', title: 'x', nodes: [{ id: 'a', label: 'A', position: { x: 0, y: 0 } }], edges: [], fields: [{ name: 'a', label: 'A', type: 'text' }] }, fragment: 'must not carry' },
  ])('rejects $label as an isError result', async ({ page: badPage, fragment }) => {
    const ctx = await setup()
    const result = await callSurface(ctx, { page: badPage })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(fragment)
  })

  it('rejects a non-agent caller (the surface has no owning session)', async () => {
    const ctx = await setup()
    const result = await callSurface(ctx, { page: page() }, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('owning agent session')
  })

  it('rejects a surfaceId replacement when updates are disabled (allowUpdate: false)', async () => {
    const ctx = await setup(false)
    const agent = agentWithSession('open-only')
    const result = await callSurface(ctx, { page: page(), surfaceId: 'a2ui-fixed' }, { agent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('updates are disabled')
    expect(agent.session.snapshotEvents().filter(e => e.type === 'a2ui/surface')).toHaveLength(0)
  })

  it('presents the call with a stable title and the page as raw input', async () => {
    const ctx = await setup()
    const def = ctx.tools.get('a2ui_surface')!
    const args = { page: page() }
    expect(def.presentCall?.(args)).toEqual({ card: 'generic', title: 'Render A2UI page', kind: 'other', rawInput: args.page })
  })

  it('unregisters the tool when its contributing fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(tool, { allowUpdate: true })
    expect(ctx.tools.schemas().some(s => s.name === 'a2ui_surface')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'a2ui_surface')).toBe(false)
  })


  describe('script write-back canonicalization', () => {
    it('carries a write entry trimmed on both sides', () => {
      const raw = {
        kind: 'form', title: 'S', fields: [{ name: 'out', label: 'Out', type: 'text' }],
        actions: [{ id: 's', label: 'Script', execution: 'script', program: 'return { x: 1 }', binds: [],
          write: [{ field: ' out ', from: ' value.x ' }] }],
      }
      const page = canonicalizeA2uiPage(raw as unknown as A2uiPageInput)
      expect((page as { actions: Array<Record<string, unknown>> }).actions![0]).toMatchObject({
        write: [{ field: 'out', from: 'value.x' }],
      })
    })

    it('rejects a write entry whose field is not an identifier', () => {
      const raw = {
        kind: 'form', title: 'S', fields: [],
        actions: [{ id: 's', label: 'Script', execution: 'script', program: 'x',
          write: [{ field: 'not a name', from: 'value' }] }],
      }
      expect(() => canonicalizeA2uiPage(raw as unknown as A2uiPageInput)).toThrow(/write` field .* must be a field identifier/)
    })

    it('rejects a write entry with an empty selector', () => {
      const raw = {
        kind: 'form', title: 'S', fields: [],
        actions: [{ id: 's', label: 'Script', execution: 'script', program: 'x',
          write: [{ field: 'a', from: '  ' }] }],
      }
      expect(() => canonicalizeA2uiPage(raw as unknown as A2uiPageInput)).toThrow(/selector/)
    })
  })

  describe('command actions canonicalization', () => {
    it('canonicalizes a command action with its command and optional timeout', () => {
      const raw = {
        kind: 'form',
        title: 'Log',
        fields: [{ name: 'sn', label: 'SN', type: 'text' }],
        actions: [{ id: 'run', label: 'Run', execution: 'command', command: 'hdc -t {sn} hilog' }],
      }
      const page = canonicalizeA2uiPage(raw as unknown as A2uiPageInput)
      const actions = (page as { actions: Array<Record<string, unknown>> }).actions!
      expect(actions[0]).toMatchObject({ id: 'run', execution: 'command', command: 'hdc -t {sn} hilog' })
      expect(actions[0]).not.toHaveProperty('tool')
    })

    it('carries a timeout when supplied and preserves it', () => {
      const raw = {
        kind: 'form',
        title: 'Log',
        fields: [{ name: 'sn', label: 'SN', type: 'text' }],
        actions: [{ id: 'run', label: 'Run', execution: 'command', command: 'sleep 2', timeoutMs: 5000 }],
      }
      const page = canonicalizeA2uiPage(raw as unknown as A2uiPageInput)
      expect((page as { actions: Array<Record<string, unknown>> }).actions![0]).toMatchObject({ timeoutMs: 5000 })
    })

    it('rejects a command action without a command', () => {
      const raw = {
        kind: 'form',
        title: 'Log',
        fields: [{ name: 'sn', label: 'SN', type: 'text' }],
        actions: [{ id: 'run', label: 'Run', execution: 'command' }],
      }
      expect(() => canonicalizeA2uiPage(raw as unknown as A2uiPageInput)).toThrow(/command.*action must carry a `command`/)
    })

    it('rejects a non-positive timeout', () => {
      const raw = {
        kind: 'form',
        title: 'Log',
        fields: [],
        actions: [{ id: 'run', label: 'Run', execution: 'command', command: 'echo hi', timeoutMs: 0 }],
      }
      expect(() => canonicalizeA2uiPage(raw as unknown as A2uiPageInput)).toThrow(/timeoutMs/)
    })
  })


  describe('script actions canonicalization', () => {
    it('canonicalizes a script action with its program and binding grants', () => {
      const raw = {
        kind: 'form',
        title: 'S',
        fields: [],
        actions: [{ id: 's', label: 'Script', execution: 'script', program: 'return 1', binds: ['text'] }],
      }
      const page = canonicalizeA2uiPage(raw as unknown as A2uiPageInput)
      expect((page as { actions: Array<Record<string, unknown>> }).actions![0]).toMatchObject({
        id: 's', execution: 'script', program: 'return 1', binds: ['text'],
      })
    })

    it('rejects a script action without a program', () => {
      const raw = {
        kind: 'form', title: 'S', fields: [],
        actions: [{ id: 's', label: 'Script', execution: 'script' }],
      }
      expect(() => canonicalizeA2uiPage(raw as unknown as A2uiPageInput)).toThrow(/script.*action must carry a `program`/)
    })

    it('rejects an unknown binding grant', () => {
      const raw = {
        kind: 'form', title: 'S', fields: [],
        actions: [{ id: 's', label: 'Script', execution: 'script', program: 'x', binds: ['hack'] }],
      }
      expect(() => canonicalizeA2uiPage(raw as unknown as A2uiPageInput)).toThrow(/unknown `binds`/)
    })
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    // A default export would make Loader unwrap only apply and drop `inject`.
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-a2ui-surface')
    expect(tool.inject).toEqual(['tools'])
    expect(typeof tool.apply).toBe('function')
  })
})
