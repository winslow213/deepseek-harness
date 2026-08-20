// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConversationEventRegistry, ConversationNodeAssembler, SlotRegistry,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ChatConversationViewNode, ConversationEventInput, ConversationMatch, ConversationNodeDefinition,
  ConversationViewDefinition, SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { makeTranslate, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { A2uiPage, A2uiSurfaceData } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import {
  A2uiPanel, type A2uiPanelProps,
} from '../src/client/A2uiPanel.tsx'
import { apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'
import {
  a2uiSurfaceDefinition, type A2uiSurfaceChatData,
} from '../src/client/a2ui-definition.ts'
import { apply as applyNode } from '../src/index.ts'
import { apply as applyInvariant } from '../src/invariant.ts'
import type {} from '../src/client/index.ts'

afterEach(cleanup)

const SESSION_ID = 'parent' as SessionId

interface ChatSnapshot {
  readonly nodes: ReadonlyMap<string, ChatConversationViewNode>
}

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] { return [a2uiSurfaceDefinition] }
  fallbackEntry(): undefined { return undefined }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] { return [chatViewDefinition] }
}

const chatViewDefinition: ConversationViewDefinition<ChatConversationViewNode, ChatSnapshot> = {
  target: 'chat',
  create: () => {
    let nodes = new Map<string, ChatConversationViewNode>()
    const snapshot = (): ChatSnapshot => ({ nodes })
    return {
      empty: snapshot(),
      replace: ({ nodes: values }) => {
        nodes = new Map(values.map(node => [node.key, node]))
        return snapshot()
      },
      apply: ({ upserts }) => {
        nodes = new Map(nodes)
        for (const node of upserts) nodes.set(node.key, node)
        return snapshot()
      },
    }
  },
}

function at(seq: number, type: string, data: unknown): ConversationEventInput {
  return { event: { seq, time: seq * 100, type, data } as ConversationEventInput['event'], view: undefined }
}

function matched(input: ConversationEventInput, role: ConversationMatch['role']): ConversationMatch {
  return { ...input, role, location: { kind: 'unresolved' } }
}

function assembler(entries: readonly ConversationEventInput[], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  value.replaceWindow(entries, hasMore)
  value.flush()
  return value
}

function surfaceData(value: ConversationNodeAssembler): A2uiSurfaceChatData | undefined {
  const snapshot = value.snapshot('chat') as ChatSnapshot
  return [...snapshot.nodes.values()][0]?.data as A2uiSurfaceChatData | undefined
}

const page = (overrides: Partial<A2uiPage> = {}): A2uiPage => ({
  title: 'Collect details',
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Jane' },
    { name: 'priority', label: 'Priority', type: 'select', options: [
      { label: 'Low', value: 'low' },
      { label: 'High', value: 'high' },
    ] },
  ],
  ...overrides,
})

describe('a2ui-surface Conversation Definition', () => {
  it('projects one a2ui/surface event into a standalone Chat node', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'a2ui/surface', { surfaceId: 'a2ui-1', page: page() }),
    ])
    const data = surfaceData(value)
    expect(data).toMatchObject({ seq: 2, surfaceId: 'a2ui-1', page: { title: 'Collect details' } })
    const node = [...(value.snapshot('chat') as ChatSnapshot).nodes.values()][0]!
    expect(node.kind).toBe('a2ui-surface')
    expect(node.anchorSeq).toBe(2)
  })

  it('opens a fresh node for a deliberately reused surfaceId', () => {
    const value = assembler([
      at(1, 'a2ui/surface', { surfaceId: 'a2ui-1', page: page({ title: 'first' }) }),
      at(2, 'a2ui/surface', { surfaceId: 'a2ui-1', page: page({ title: 'second' }) }),
    ])
    const snapshot = value.snapshot('chat') as ChatSnapshot
    expect(snapshot.nodes.size).toBe(2)
    const titles = [...snapshot.nodes.values()].map(node => (node.data as A2uiSurfaceChatData).page.title)
    expect(titles.sort()).toEqual(['first', 'second'])
  })

  it('produces the same node through live append as complete replay', () => {
    const events = [
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'a2ui/surface', { surfaceId: 'a2ui-1', page: page() }),
    ]
    const value = assembler(events.slice(0, 1))
    value.append(events[1]!)
    value.flush()
    expect(surfaceData(value)).toEqual(surfaceData(assembler(events)))
  })

  it('rejects a start match that is not a2ui/surface', () => {
    const invalidStart = matched(at(1, 'turn/start', { turn: 1 }), 'start')
    const emptyContext: Parameters<typeof a2uiSurfaceDefinition.start>[0] = {
      key: 'a2ui-surface:a2ui-1', kind: 'a2ui-surface', id: 'a2ui-1',
      matches: [invalidStart], start: invalidStart, state: undefined, current: new Map(),
    }
    const reader: Parameters<typeof a2uiSurfaceDefinition.start>[2] = { previous: () => undefined }
    expect(() => a2uiSurfaceDefinition.start(emptyContext, invalidStart, reader))
      .toThrow('a2ui-surface start requires a2ui/surface')
  })

  it('keeps an update no-op and stays null without a start', () => {
    const surface: A2uiSurfaceData = { surfaceId: 'a2ui-1', page: page() }
    const start = matched(at(1, 'a2ui/surface', surface), 'start')
    const context = {
      key: 'a2ui-surface:a2ui-1', kind: 'a2ui-surface', id: 'a2ui-1',
      matches: [start], start, state: surface, current: new Map(),
    } as Parameters<typeof a2uiSurfaceDefinition.update>[0]
    const update = matched(at(2, 'a2ui/surface', {
      ...surface, page: page({ title: 'second' }),
    }), 'update')
    expect(a2uiSurfaceDefinition.update(context, update)).toBe(surface)
    expect(a2uiSurfaceDefinition.buildViewNode?.({
      ...context, matches: [], start: undefined, state: undefined,
    })).toBeNull()
    const node = a2uiSurfaceDefinition.buildViewNode?.(context) as ChatConversationViewNode | null | undefined
    if (node === null) throw new Error('expected a2ui-surface Chat node')
    if (node === undefined) throw new Error('expected a2ui-surface Chat view builder')
    expect(node.kind).toBe('a2ui-surface')
    expect((node.data as A2uiSurfaceChatData).surfaceId).toBe('a2ui-1')
  })
})

function node(data: A2uiSurfaceChatData): A2uiPanelProps['node'] {
  return {
    key: `12:a2ui-surface${data.surfaceId}#${data.seq}`,
    kind: 'a2ui-surface',
    id: `${data.surfaceId}#${data.seq}`,
    target: 'chat',
    anchorSeq: data.seq,
    location: { kind: 'unresolved' },
    visibility: 'visible',
    data,
  }
}

function panelProps(
  data: A2uiSurfaceChatData,
  phase: string = 'plain',
  inputActions: Partial<A2uiPanelProps['inputActions']> = {},
): A2uiPanelProps {
  return {
    node: node(data),
    sessionId: SESSION_ID,
    useSessions: (() => undefined) as unknown as A2uiPanelProps['useSessions'],
    useSession: (() => undefined) as unknown as A2uiPanelProps['useSession'],
    useProjection: () => undefined,
    // The panel reads `state.phase` from the input machine; stub it to answer
    // the requested phase. The generic snapshot hook is faked through the
    // repo's test escape hatch like sibling panel tests.
    useInput: ((selector: (state: { phase: string }) => string) => selector({ phase })) as unknown as A2uiPanelProps['useInput'],
    inputActions: {
      setDraft: () => {}, addImages: () => false, removeImage: () => {}, pruneImages: () => {}, submit: () => {},
      ...inputActions,
    },
    useWorkspaces: (() => undefined) as unknown as A2uiPanelProps['useWorkspaces'],
    useTurnData: () => undefined,
    selectedCallId: undefined,
    cwd: undefined,
    openFile: () => {},
    inspectCall: () => {},
    forkAt: () => {},
    loadImage: () => Promise.reject(new Error('unused')),
    fileMentions: () => undefined,
    t: makeTranslate(zh),
  }
}

function renderSurface(overrides: Partial<A2uiSurfaceChatData> = {}) {
  return render(<A2uiPanel {...panelProps({ seq: 2, surfaceId: 'a2ui-1', page: page(), ...overrides })} />)
}

describe('A2uiPanel', () => {
  it('renders the page title, fields, and submit button', () => {
    renderSurface()
    expect(screen.getByText('Collect details')).toBeTruthy()
    expect(screen.getByLabelText('Name', { exact: false })).toBeTruthy()
    expect(screen.getByLabelText('Priority', { exact: false })).toBeTruthy()
    expect(screen.getByRole('button', { name: '提交' })).toBeTruthy()
    expect(screen.getByText('必填')).toBeTruthy()
  })

  it('uses the model-authored submit label when provided', () => {
    renderSurface({ page: page({ submitLabel: 'Go' }) })
    expect(screen.getByRole('button', { name: 'Go' })).toBeTruthy()
  })

  it('submits the collected values as one user message carrying the surfaceId', () => {
    const setDraft = vi.fn()
    const submit = vi.fn()
    render(<A2uiPanel {...panelProps({ seq: 2, surfaceId: 'a2ui-1', page: page() }, 'plain', { setDraft, submit })} />)
    fireEvent.change(screen.getByLabelText('Name', { exact: false }), { target: { value: 'Jane' } })
    fireEvent.change(screen.getByLabelText('Priority', { exact: false }), { target: { value: 'high' } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(setDraft).toHaveBeenCalledWith(JSON.stringify({
      a2uiSubmit: { surfaceId: 'a2ui-1', values: { name: 'Jane', priority: 'high' } },
    }))
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('blocks submission until required fields are filled', () => {
    const setDraft = vi.fn()
    const submit = vi.fn()
    render(<A2uiPanel {...panelProps({ seq: 2, surfaceId: 'a2ui-1', page: page() }, 'plain', { setDraft, submit })} />)
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(screen.getByRole('alert').textContent).toContain('Name')
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('refuses submission while the input machine is busy', () => {
    const setDraft = vi.fn()
    const submit = vi.fn()
    render(<A2uiPanel {...panelProps({ seq: 2, surfaceId: 'a2ui-1', page: page() }, 'submitting', { setDraft, submit })} />)
    fireEvent.change(screen.getByLabelText('Name', { exact: false }), { target: { value: 'Jane' } })
    // The busy state disables the submit button, so a click cannot fire. The
    // in-flight guard is defensive: dispatch a submit directly to prove a
    // racing submission is refused.
    const form = screen.getByText('Collect details').closest('form')!
    fireEvent.submit(form)
    expect(screen.getByRole('alert').textContent).toContain('处理')
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('collects checkbox and number fields by their field kinds', () => {
    const setDraft = vi.fn()
    const submit = vi.fn()
    render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: page({ fields: [
        { name: 'agree', label: 'Agree', type: 'checkbox', required: true },
        { name: 'count', label: 'Count', type: 'number' },
      ] }),
    }, 'plain', { setDraft, submit })} />)
    fireEvent.click(screen.getByLabelText('Agree', { exact: false }))
    fireEvent.change(screen.getByLabelText('Count', { exact: false }), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(setDraft).toHaveBeenCalledWith(JSON.stringify({
      a2uiSubmit: { surfaceId: 'a2ui-1', values: { agree: true, count: 3 } },
    }))
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('keeps an unchecked required checkbox invalid', () => {
    const setDraft = vi.fn()
    const submit = vi.fn()
    render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: page({ fields: [{ name: 'agree', label: 'Agree', type: 'checkbox', required: true }] }),
    }, 'plain', { setDraft, submit })} />)
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(screen.getByRole('alert').textContent).toContain('Agree')
    expect(submit).not.toHaveBeenCalled()
  })
})

class TestSessions extends Service {
  constructor(ctx: Context) { super(ctx, 'sessions') }
}

describe('plugin lifecycle', () => {
  it('registers and removes the Definition and keyed renderer with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
    ctx.provide('remote', { $on: () => () => {} } as never)
    ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    await ctx.plugin(ConversationEventRegistry).await()
    await ctx.plugin(TestSessions).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, () => null)
    await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.conversationEvents.entries().map(entry => entry.kind)).toEqual(['a2ui-surface'])
    expect(ctx.slots.entries('conversation.chat.node')).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.conversationEvents.entries()).toEqual([])
    expect(ctx.slots.entries('conversation.chat.node')).toEqual([])

    const replacement = ctx.plugin({ inject: [...inject], apply })
    await replacement.await()
    expect(ctx.conversationEvents.entries().map(entry => entry.kind)).toEqual(['a2ui-surface'])
    expect(ctx.slots.entries('conversation.chat.node')).toHaveLength(1)
    await replacement.dispose()
  })

  it('keeps the node half inert and registers invariant ownership', async () => {
    applyNode()
    const registered: string[] = []
    const ctx = new Context()
    ctx.provide('invariants')
    ctx.set('invariants', {
      register: (pkg: string) => { registered.push(pkg); return () => {} },
    } as never)
    await applyInvariant(ctx)
    expect(registered).toEqual(['@deepseek-ai/dsh-client-ui-a2ui'])
  })
})
