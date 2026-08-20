import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { type Agent } from '@deepseek-ai/dsh-agent'

import * as tool from '../src/index.ts'

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
    callId: CallId(`call-${++callCounter}`),
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
    title: 'Collect details',
    fields: [
      { name: 'name', label: 'Full name', type: 'text', required: true },
      { name: 'reason', label: 'Reason', type: 'select', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
    ],
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
    expect(pageSpec.required).toEqual(['title', 'fields'])
    expect(Object.keys(pageSpec.properties ?? {}).sort()).toEqual([
      'description', 'fields', 'instruction', 'submitLabel', 'title',
    ])
    const fieldProps = ((pageSpec.properties!.fields as { items: { properties: Record<string, unknown> } }).items.properties)
    expect(Object.keys(fieldProps).sort()).toEqual(['help', 'label', 'name', 'options', 'placeholder', 'required', 'type'])
    const typeSpec = fieldProps.type as { enum?: string[] }
    expect(typeSpec.enum).toEqual(['text', 'textarea', 'select', 'number', 'checkbox'])
  })

  it('appends an a2ui/surface event carrying the page to the calling session', async () => {
    const ctx = await setup()
    const agent = agentWithSession('writer')
    const result = await callSurface(ctx, { page: page() }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a2ui_surface success')
    const value = result.value as { surfaceId: string; accepted: boolean; fieldCount: number }
    expect(value.accepted).toBe(true)
    expect(value.fieldCount).toBe(2)
    expect(value.surfaceId).toMatch(/^a2ui-/)
    expect(text(result)).toContain(`Rendered A2UI surface ${value.surfaceId} with 2 fields`)

    const event = agent.session.events.findLast(e => e.type === 'a2ui/surface')!
    expect(event.data.surfaceId).toBe(value.surfaceId)
    expect(event.data.page.title).toBe('Collect details')
    expect(event.data.page.fields).toHaveLength(2)
  })

  it('stores trimmed title and field names (the renderer keys), not raw input', async () => {
    const ctx = await setup()
    const agent = agentWithSession('trim')
    const result = await callSurface(ctx, {
      page: {
        title: '  Trim me  ',
        fields: [
          { name: ' a ', label: ' Label A ', type: 'text' },
        ],
      },
    }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a2ui_surface success')

    const event = agent.session.events.findLast(e => e.type === 'a2ui/surface')!
    expect(event.data.page.title).toBe('Trim me')
    expect(event.data.page.fields[0]!.name).toBe('a')
    expect(event.data.page.fields[0]!.label).toBe('Label A')
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
    expect(agent.session.events.filter(e => e.type === 'a2ui/surface')).toHaveLength(2)
  })

  it('replaces an existing surface when the caller passes a stable surfaceId', async () => {
    const ctx = await setup()
    const agent = agentWithSession('replacer')
    const surfaceId = 'a2ui-fixed'
    await callSurface(ctx, { page: page({ title: 'V1' }), surfaceId }, { agent })
    await callSurface(ctx, { page: page({ title: 'V2' }) }, { agent })
    const surfaces = agent.session.events.filter(e => e.type === 'a2ui/surface')
    expect(surfaces).toHaveLength(2)
    expect(surfaces[0]!.data.surfaceId).toBe(surfaceId)
    expect(surfaces[1]!.data.surfaceId).not.toBe(surfaceId)
  })

  it('rejects a malformed field type before execute runs (registry arg-validation)', async () => {
    const ctx = await setup()
    const result = await callSurface(ctx, {
      page: { title: 'x', fields: [{ name: 'a', label: 'A', type: 'radio' }] },
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
      page: { title: 'x', fields: [{ name: 'a', label: 'A', type: 'text', nested: { x: 1 } }] },
    })
    expect(result.isError).toBe(true)
  })

  it.each([
    { label: 'empty title', page: { title: '   ', fields: [{ name: 'a', label: 'A', type: 'text' }] }, fragment: 'title' },
    { label: 'empty field name', page: { title: 'x', fields: [{ name: '  ', label: 'A', type: 'text' }] }, fragment: 'non-empty' },
    { label: 'empty field label', page: { title: 'x', fields: [{ name: 'a', label: ' ', type: 'text' }] }, fragment: 'non-empty' },
    { label: 'duplicate field names', page: { title: 'x', fields: [{ name: 'a', label: 'A', type: 'text' }, { name: 'a', label: 'A2', type: 'text' }] }, fragment: 'duplicate' },
    { label: 'select without options', page: { title: 'x', fields: [{ name: 'a', label: 'A', type: 'select' }] }, fragment: 'at least one option' },
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
    expect(agent.session.events.filter(e => e.type === 'a2ui/surface')).toHaveLength(0)
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

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    // A default export would make Loader unwrap only apply and drop `inject`.
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-a2ui-surface')
    expect(tool.inject).toEqual(['tools'])
    expect(typeof tool.apply).toBe('function')
  })
})
