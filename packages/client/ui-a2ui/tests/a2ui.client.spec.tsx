// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConversationNodeAssembler,
  UiConversation,
  type ConversationNodeDefinition,
  type ConversationMatch,
  type ConversationStartMatch,
  type ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ChatConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  SessionLiveEventEntry,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { makeTranslate, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { A2uiCanvasPage, A2uiFormPage, A2uiSurfaceData } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import {
  A2uiPanel, type A2uiPanelProps,
} from '../src/client/A2uiPanel.tsx'
import {
  a2uiBendForPoint, a2uiEdgeGeometry,
} from '../src/client/A2uiCanvasPanel.tsx'
import { apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'
import {
  a2uiSurfaceDefinition, type A2uiSurfaceChatData,
} from '../src/client/a2ui-definition.ts'
import { apply as applyNode } from '../src/index.ts'
import { apply as applyInvariant } from '../src/invariant.ts'
import type {} from '../src/client/index.ts'

afterEach(cleanup)

/** Evaluate the cubic Bézier encoded by `M sx sy C c1x c1y, c2x c2y, tx ty` at t = 1/2. */
function cubicMidpoint(path: string): { x: number; y: number } {
  // `a2uiEdgeGeometry` always emits exactly the eight numbers above.
  const [sx, sy, c1x, c1y, c2x, c2y, tx, ty] = path
    .match(/-?\d+(?:\.\d+)?/g)!
    .map(Number) as [number, number, number, number, number, number, number, number]
  return {
    x: sx / 8 + 3 * c1x / 8 + 3 * c2x / 8 + tx / 8,
    y: sy / 8 + 3 * c1y / 8 + 3 * c2y / 8 + ty / 8,
  }
}

/*
 * React Flow sizes its pane and measures node/handle positions with
 * ResizeObserver + getBoundingClientRect, neither of which jsdom performs.
 * The harness below feeds it plausible dimensions:
 *   - a DOMMatrixReadOnly shim (React Flow only reads the viewport scale),
 *   - fixed rects for the pane, nodes, and handles,
 *   - a ResizeObserver that fires its initial entry synchronously so the
 *     measurement pass actually runs and edges get rendered.
 */
if (typeof globalThis.DOMMatrixReadOnly === 'undefined') {
  class DOMMatrixReadOnlyShim {
    readonly m11: number
    readonly m12: number
    readonly m21: number
    readonly m22: number
    readonly m41: number
    readonly m42: number

    constructor(transform: string) {
      const translate = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(transform)
      const scale = /scale\(([-\d.]+)\)/.exec(transform)
      this.m11 = scale ? Number(scale[1]) : 1
      this.m12 = 0
      this.m21 = 0
      this.m22 = scale ? Number(scale[1]) : 1
      this.m41 = translate ? Number(translate[1]) : 0
      this.m42 = translate ? Number(translate[2]) : 0
    }
  }
  globalThis.DOMMatrixReadOnly = DOMMatrixReadOnlyShim as unknown as typeof DOMMatrixReadOnly
}

const realGetBoundingClientRect: (this: Element) => DOMRect =
  Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')!.value as (this: Element) => DOMRect
const makeRect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({ }) })

/*
 * React Flow sizes nodes through `offsetWidth`/`offsetHeight` and derives edge
 * paths from `getBoundingClientRect()` on nodes and handles — all of which are
 * 0 or identity in jsdom. The stubs below synthesize plausible layout:
 *   - nodes report 120x40 and their flow position (parsed from the transform
 *     React Flow applies) offset by the viewport translate/zoom,
 *   - handles sit on the node border per their `data-handlepos`,
 *   - the `.react-flow` pane reports 600x400.
 * This makes `handleBounds` get measured, so edges actually render and the
 * connect/reconnect geometry resolves against real positions.
 */
const NODE_WIDTH = 120
const NODE_HEIGHT = 40
const HANDLE_SIZE = 10

function viewportTransform(): { x: number; y: number; zoom: number } {
  const viewport = document.querySelector('.react-flow__viewport') as HTMLElement | null
  if (viewport === null) return { x: 0, y: 0, zoom: 1 }
  const match = viewport.style.transform.match(/translate\(([-\d.]+)px,([-\d.]+)px\)\s*scale\(([-\d.]+)\)/)
  if (match === null) return { x: 0, y: 0, zoom: 1 }
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) }
}

function nodeFlowPosition(node: HTMLElement): { x: number; y: number } {
  const match = node.style.transform.match(/translate\(([-\d.]+)px,([-\d.]+)px\)/)
  if (match === null) return { x: 0, y: 0 }
  return { x: Number(match[1]), y: Number(match[2]) }
}

function handleOffsetWithinNode(handle: Element): { x: number; y: number } {
  const position = handle.getAttribute('data-handlepos')
  switch (position) {
    case 'left': return { x: 0, y: NODE_HEIGHT / 2 }
    case 'right': return { x: NODE_WIDTH, y: NODE_HEIGHT / 2 }
    case 'top': return { x: NODE_WIDTH / 2, y: 0 }
    default: return { x: NODE_WIDTH / 2, y: NODE_HEIGHT }
  }
}

Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
  if (this.classList.contains('react-flow__node')) {
    const { x, y, zoom } = viewportTransform()
    const position = nodeFlowPosition(this as HTMLElement)
    return makeRect(x + position.x * zoom, y + position.y * zoom, NODE_WIDTH, NODE_HEIGHT)
  }
  if (this.classList.contains('react-flow__handle')) {
    const node = this.closest('.react-flow__node') as HTMLElement | null
    const { x, y, zoom } = viewportTransform()
    const position = node === null ? { x: 0, y: 0 } : nodeFlowPosition(node)
    const offset = handleOffsetWithinNode(this)
    return makeRect(x + (position.x + offset.x) * zoom, y + (position.y + offset.y) * zoom, HANDLE_SIZE, HANDLE_SIZE)
  }
  if (this.classList.contains('react-flow')) return makeRect(0, 0, 600, 400)
  return realGetBoundingClientRect.call(this)
}

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get(this: HTMLElement): number {
    if (this.classList.contains('react-flow__node')) return NODE_WIDTH
    if (this.classList.contains('react-flow__handle')) return HANDLE_SIZE
    if (this.classList.contains('react-flow')) return 600
    return 0
  },
})

Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement): number {
    if (this.classList.contains('react-flow__node')) return NODE_HEIGHT
    if (this.classList.contains('react-flow__handle')) return HANDLE_SIZE
    if (this.classList.contains('react-flow')) return 400
    return 0
  },
})

// jsdom cannot hit-test, but React Flow resolves a drop onto a handle only
// when `elementFromPoint` returns that handle. Hand it a hit test over the
// mocked handle rects, whose screen positions the rect mock already computes.
document.elementFromPoint = (x: number, y: number): Element | null => {
  const handles = document.querySelectorAll('.react-flow__handle')
  for (const handle of handles) {
    const rect = handle.getBoundingClientRect()
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return handle
    }
  }
  return null
}

// jsdom's SVG elements cannot report a bounding box; edge labels need one
// when their text measures itself, so hand out an empty box.
if (!('getBBox' in SVGElement.prototype)) {
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox =
    () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect
}

class ResizeObserverMock {
  private readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }

  observe(target: Element): void {
    // A real ResizeObserver delivers after layout, once React Flow has
    // populated its node lookup; firing synchronously inside observe() would
    // run before that, so measurement would no-op. Deferring to a microtask
    // matches the real timing, and @testing-library's `act` flush runs it
    // before `render()` returns. The pan-zoom observer reads `contentRect`
    // for its extent, so carry one.
    queueMicrotask(() => {
      const entry = {
        target,
        contentRect: makeRect(0, 0, 600, 400),
      } as unknown as ResizeObserverEntry
      this.callback([entry], this)
    })
  }

  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverMock

/**
 * Map a flow-coordinate point to a client point through the viewport
 * transform React Flow currently applies, so pointer gestures can target a
 * handle whose on-screen position jsdom cannot measure.
 */
function flowToScreen(container: HTMLElement, x: number, y: number): [number, number] {
  const viewport = container.querySelector('.react-flow__viewport') as HTMLElement
  const match = viewport.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/)
  if (match === null) throw new Error(`unexpected viewport transform: ${viewport.style.transform}`)
  const tx = Number(match[1])
  const ty = Number(match[2])
  const zoom = Number(match[3])
  return [x * zoom + tx, y * zoom + ty]
}

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

function at(seq: number, type: string, data: unknown): SessionEvent {
  return { seq, time: seq * 100, type, data } as SessionEvent
}

function input(event: SessionEvent): SessionLiveEventEntry {
  return { type: 'event', event }
}

function matched(event: SessionEvent, role: 'start'): ConversationStartMatch
function matched(event: SessionEvent, role: 'update'): ConversationMatch
function matched(event: SessionEvent, role: ConversationMatch['role']): ConversationMatch {
  return { event, role, location: { kind: 'unresolved' } }
}

function assembler(entries: readonly SessionEvent[], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  value.replaceWindow(entries.map(input), hasMore)
  value.activateTarget('chat')
  value.flush()
  return value
}

function surfaceData(value: ConversationNodeAssembler): A2uiSurfaceChatData | undefined {
  const snapshot = value.snapshot('chat') as ChatSnapshot
  return [...snapshot.nodes.values()][0]?.data as A2uiSurfaceChatData | undefined
}

const page = (overrides: Partial<Omit<A2uiFormPage, 'kind'>> = {}): A2uiFormPage => ({
  kind: 'form',
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

const canvasPage = (overrides: Partial<Omit<A2uiCanvasPage, 'kind'>> = {}): A2uiCanvasPage => ({
  kind: 'canvas',
  title: 'Plan a flow',
  nodes: [
    { id: 'start', label: 'Start', role: 'start', position: { x: 0, y: 0 } },
    { id: 'end', label: 'End', role: 'end', position: { x: 200, y: 100 } },
  ],
  edges: [{ id: 'e1', source: 'start', target: 'end', label: 'then' }],
  ...overrides,
})

describe('bendable edge geometry', () => {
  it('keeps bend 0 straight with the apex on the segment midpoint', () => {
    const { path, control } = a2uiEdgeGeometry(0, 0, 100, 0, 0)
    expect(control).toEqual({ x: 50, y: 0 })
    expect(path).toBe('M 0 0 C 25 0, 75 0, 100 0')
  })

  it('bows the apex perpendicular to the segment by the bend distance', () => {
    const { path, control } = a2uiEdgeGeometry(0, 0, 100, 0, 40)
    expect(control).toEqual({ x: 50, y: 40 })
    // Control points sit at 4/3 of the bend so the curve's midpoint — where
    // the drag handle and label render — lands exactly on the apex: evaluating
    // the cubic at t = 1/2 gives y = (3/8)c + (3/8)c = (3/4)c = bend.
    expect(path).toBe('M 0 0 C 25 53.333333333333336, 75 53.333333333333336, 100 0')
    expect(cubicMidpoint(path)).toEqual({ x: 50, y: 40 })
  })

  it('mirrors the bow for a negative bend', () => {
    const { control } = a2uiEdgeGeometry(0, 0, 100, 0, -40)
    expect(control).toEqual({ x: 50, y: -40 })
  })

  it('normalizes a zero-length segment to a degenerate point', () => {
    const { path, control } = a2uiEdgeGeometry(0, 0, 0, 0, 10)
    expect(control).toEqual({ x: 0, y: 0 })
    expect(path).not.toContain('NaN')
  })

  it('returns the signed perpendicular distance as the bend', () => {
    expect(a2uiBendForPoint(0, 0, 100, 0, { x: 50, y: 40 })).toBe(40)
    expect(a2uiBendForPoint(0, 0, 100, 0, { x: 50, y: -40 })).toBe(-40)
    expect(a2uiBendForPoint(0, 0, 0, 100, { x: 40, y: 50 })).toBe(-40)
    expect(a2uiBendForPoint(0, 0, 100, 0, { x: 30, y: 0 })).toBe(0)
    // A zero-length segment normalizes to a unit length like the path math.
    expect(a2uiBendForPoint(0, 0, 0, 0, { x: 5, y: 7 })).toBe(0)
  })
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
    value.append(input(events[1]!))
    value.activateTarget('chat')
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
    useConversation: (() => undefined) as unknown as A2uiPanelProps['useConversation'],
    useChat: (() => undefined) as unknown as A2uiPanelProps['useChat'],
    useTrajectory: (() => undefined) as unknown as A2uiPanelProps['useTrajectory'],
    useSessionPendingInteraction: (() => undefined) as unknown as A2uiPanelProps['useSessionPendingInteraction'],
    useTurnData: () => undefined,
    selectedCallId: undefined,
    cwd: undefined,
    openFile: () => {},
    inspectCall: () => {},
    forkAt: () => {},
    loadImage: vi.fn(() => Promise.resolve('blob:unused')),
    renderMessageImages: () => null,
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

  it('renders the page description and instruction around a textarea field', () => {
    renderSurface({ page: page({
      title: 'Notes',
      description: 'Fill in the details below.',
      instruction: 'Press submit when you are done.',
      fields: [{ name: 'notes', label: 'Notes', type: 'textarea' }],
    }) })
    expect(screen.getByText('Fill in the details below.')).toBeTruthy()
    expect(screen.getByText('Press submit when you are done.')).toBeTruthy()
    expect(screen.getByLabelText('Notes', { exact: false })).toBeTruthy()
  })

  it('keeps a select field empty when it has no options', () => {
    renderSurface({ page: page({ fields: [{ name: 'pick', label: 'Pick', type: 'select' }] }) })
    const select = screen.getByLabelText('Pick', { exact: false }) as HTMLSelectElement
    expect(select.value).toBe('')
  })

  it('submits an untouched number field as an empty string', () => {
    const setDraft = vi.fn()
    const submit = vi.fn()
    render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: page({ fields: [{ name: 'count', label: 'Count', type: 'number' }] }),
    }, 'plain', { setDraft, submit })} />)
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(setDraft).toHaveBeenCalledWith(JSON.stringify({
      a2uiSubmit: { surfaceId: 'a2ui-1', values: { count: '' } },
    }))
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('renders help text beside a checkbox and under a text field', () => {
    renderSurface({ page: page({ fields: [
      { name: 'agree', label: 'Agree', type: 'checkbox', help: 'Tick to agree.' },
      { name: 'name', label: 'Name', type: 'text', help: 'Your display name.' },
    ] }) })
    expect(screen.getByText('Tick to agree.')).toBeTruthy()
    expect(screen.getByText('Your display name.')).toBeTruthy()
  })

  it('routes a canvas page to the draggable graph renderer', () => {
    renderSurface({ page: canvasPage() })
    expect(screen.getByText('Plan a flow')).toBeTruthy()
    expect(screen.getByRole('button', { name: '提交' })).toBeTruthy()
    expect(screen.getByText('Start')).toBeTruthy()
    expect(screen.getByText('End')).toBeTruthy()
  })

  it('submits the arranged graph as one user message carrying the surfaceId', () => {
    const setDraft = vi.fn()
    const submit = vi.fn()
    // The third node carries a detail but no role, and the second edge carries
    // no label, so the seed and submit projections cover both optional fields.
    render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: canvasPage({
        nodes: [
          { id: 'start', label: 'Start', role: 'start', position: { x: 0, y: 0 } },
          { id: 'end', label: 'End', role: 'end', position: { x: 200, y: 100 } },
          { id: 'mid', label: 'Mid', detail: 'Draft', position: { x: 100, y: 200 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'end', label: 'then' },
          { id: 'e2', source: 'mid', target: 'end' },
        ],
      }),
    }, 'plain', { setDraft, submit })} />)
    fireEvent.submit(screen.getByText('Plan a flow').closest('form')!)
    expect(setDraft).toHaveBeenCalledWith(JSON.stringify({
      a2uiSubmit: {
        surfaceId: 'a2ui-1',
        graph: {
          nodes: [
            { id: 'start', label: 'Start', position: { x: 0, y: 0 }, role: 'start' },
            { id: 'end', label: 'End', position: { x: 200, y: 100 }, role: 'end' },
            { id: 'mid', label: 'Mid', detail: 'Draft', position: { x: 100, y: 200 } },
          ],
          edges: [
            { id: 'e1', source: 'start', target: 'end', label: 'then' },
            { id: 'e2', source: 'mid', target: 'end' },
          ],
        },
      },
    }))
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('edits a node label and detail on double-click and submits the new content', () => {
    const setDraft = vi.fn()
    const submit = vi.fn()
    render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: canvasPage(),
    }, 'plain', { setDraft, submit })} />)

    fireEvent.doubleClick(screen.getByText('Start'))
    fireEvent.change(screen.getByLabelText('节点标题'), { target: { value: '开始' } })
    fireEvent.change(screen.getByLabelText('自定义内容…'), { target: { value: '第一步' } })
    fireEvent.keyDown(screen.getByLabelText('节点标题'), { key: 'Enter' })

    // The card shows the committed content instead of the inputs.
    expect(screen.getByText('开始')).toBeTruthy()
    expect(screen.getByText('第一步')).toBeTruthy()
    expect(screen.queryByLabelText('节点标题')).toBeNull()

    fireEvent.submit(screen.getByText('Plan a flow').closest('form')!)
    expect(setDraft).toHaveBeenCalledWith(JSON.stringify({
      a2uiSubmit: {
        surfaceId: 'a2ui-1',
        graph: {
          nodes: [
            { id: 'start', label: '开始', detail: '第一步', position: { x: 0, y: 0 }, role: 'start' },
            { id: 'end', label: 'End', position: { x: 200, y: 100 }, role: 'end' },
          ],
          edges: [{ id: 'e1', source: 'start', target: 'end', label: 'then' }],
        },
      },
    }))
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('cancels a node edit on Escape without touching the label', () => {
    render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: canvasPage(),
    })} />)

    fireEvent.doubleClick(screen.getByText('Start'))
    fireEvent.change(screen.getByLabelText('节点标题'), { target: { value: '不要这个' } })
    fireEvent.keyDown(screen.getByLabelText('节点标题'), { key: 'Escape' })

    expect(screen.getByText('Start')).toBeTruthy()
    expect(screen.queryByLabelText('节点标题')).toBeNull()
    expect(screen.queryByText('不要这个')).toBeNull()
  })

  it('cancels a detail edit on Escape and commits it with Ctrl+Enter', () => {
    render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: canvasPage(),
    })} />)

    // Escape inside the detail textarea discards the draft.
    fireEvent.doubleClick(screen.getByText('Start'))
    const detail = screen.getByLabelText('自定义内容…')
    fireEvent.change(detail, { target: { value: '草稿' } })
    fireEvent.keyDown(detail, { key: 'Escape' })
    expect(screen.getByText('Start')).toBeTruthy()
    expect(screen.queryByText('草稿')).toBeNull()

    // A plain Enter keeps editing (detail commits only with Ctrl/Cmd+Enter).
    fireEvent.doubleClick(screen.getByText('Start'))
    fireEvent.change(screen.getByLabelText('自定义内容…'), { target: { value: '第一步' } })
    fireEvent.keyDown(screen.getByLabelText('自定义内容…'), { key: 'Enter' })
    expect(screen.getByLabelText('自定义内容…')).toBeTruthy()

    fireEvent.keyDown(screen.getByLabelText('自定义内容…'), { key: 'Enter', ctrlKey: true })
    expect(screen.getByText('第一步')).toBeTruthy()
    expect(screen.queryByLabelText('自定义内容…')).toBeNull()
  })

  it('keeps the card styling when a selected node is edited', () => {
    const { container } = render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: canvasPage(),
    })} />)

    // Clicking the node selects it; the wrapper and the custom card both mark
    // the selection, and the card keeps that styling once editing starts.
    const node = screen.getByText('Start').closest('.react-flow__node') as HTMLElement
    fireEvent.click(node)
    expect(container.querySelector('.react-flow__node.selected')).toBeTruthy()
    expect(node.className).toContain('selected')

    fireEvent.doubleClick(screen.getByText('Start'))
    expect(screen.getByLabelText('节点标题')).toBeTruthy()
    expect(node.className).toContain('selected')
  })

  it('drops a blank label on commit without touching the card', () => {
    render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: canvasPage(),
    })} />)

    fireEvent.doubleClick(screen.getByText('Start'))
    fireEvent.change(screen.getByLabelText('节点标题'), { target: { value: '   ' } })
    fireEvent.keyDown(screen.getByLabelText('节点标题'), { key: 'Enter' })

    // The blank label is not committed; the edit still closes and the card
    // keeps its original content.
    expect(screen.getByText('Start')).toBeTruthy()
    expect(screen.queryByLabelText('节点标题')).toBeNull()
  })

  it('refuses to submit the arranged graph while the input machine is busy', () => {
    const setDraft = vi.fn()
    const submit = vi.fn()
    render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: canvasPage(),
    }, 'submitting', { setDraft, submit })} />)
    fireEvent.submit(screen.getByText('Plan a flow').closest('form')!)
    expect(screen.getByRole('alert').textContent).toContain('处理')
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('pulls a connected line bend handle to route it around a node', async () => {
    const { container } = render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: canvasPage(),
    })} />)

    // Node/handle measurement runs through the (asynchronous) ResizeObserver
    // round, so the seeded edge materializes after the initial render pass.
    const edgePath = await waitFor(() => {
      const path = container.querySelector('.react-flow__edge-path') as SVGPathElement | null
      if (path === null) throw new Error('seed edge not rendered')
      return path
    })
    const straight = edgePath.getAttribute('d')

    // The bend handle is the apex group inside the edge: a transparent hit
    // disc plus the visible knob dot.
    const circles = container.querySelectorAll('.react-flow__edge circle')
    const dot = circles[1] as SVGCircleElement
    const handle = dot.closest('g') as SVGGElement
    expect(dot.getAttribute('r')).toBe('3.5')

    // A move before the pull is ignored: the path stays straight.
    fireEvent.pointerMove(handle, { clientX: 420, clientY: 30 })
    expect(edgePath.getAttribute('d')).toBe(straight)

    fireEvent.pointerDown(handle)
    // Pulling grows the knob so the grab reads as live.
    expect(dot.getAttribute('r')).toBe('5')
    fireEvent.pointerMove(handle, { clientX: 420, clientY: 30 })
    await waitFor(() => { expect(edgePath.getAttribute('d')).not.toBe(straight) })
    fireEvent.pointerUp(handle)
    expect(dot.getAttribute('r')).toBe('3.5')
  })

  it('connects a new line by dragging a source handle onto a target handle', async () => {
    // A third node with no seeded edge gives the drag a connection React Flow
    // will accept: dragging start onto the existing end would be rejected as
    // a duplicate of the seeded start→end edge.
    const { container } = render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: canvasPage({
        nodes: [
          { id: 'start', label: 'Start', role: 'start', position: { x: 0, y: 0 } },
          { id: 'end', label: 'End', role: 'end', position: { x: 200, y: 100 } },
          { id: 'mid', label: 'Mid', position: { x: 100, y: 200 } },
        ],
      }),
    })} />)

    // The seeded edge renders once the (asynchronous) measurement pass lands.
    await waitFor(() => { expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(1) })

    // The start node's source handle connects to the third node's target
    // handle (its left border at flow x=100): a node pair with no existing
    // edge. Map that point to screen through the viewport transform.
    const source = container.querySelector('.react-flow__handle.source') as HTMLElement
    expect(source).toBeTruthy()
    const [sx, sy] = flowToScreen(container, 100, 220)
    fireEvent.mouseDown(source, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseMove(document, { clientX: sx, clientY: sy })
    fireEvent.mouseUp(document, { clientX: sx, clientY: sy })

    await waitFor(() => { expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(2) })
  })

  it('reconnects a line endpoint by dragging its updater anchor onto another handle', async () => {
    // A second edge stays put while the first is re-targeted, so the
    // reconnect projection preserves the untouched edges.
    const { container } = render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: canvasPage({
        nodes: [
          { id: 'start', label: 'Start', role: 'start', position: { x: 0, y: 0 } },
          { id: 'end', label: 'End', role: 'end', position: { x: 200, y: 100 } },
          { id: 'mid', label: 'Mid', position: { x: 100, y: 200 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'end', label: 'then' },
          { id: 'e2', source: 'mid', target: 'end' },
        ],
      }),
    })} />)

    // The source updater anchor hangs off the edge's source end; dragging it
    // onto the end node's source handle re-targets the edge's source. The
    // first anchor in the DOM belongs to the first seeded edge.
    const anchor = await waitFor(() => {
      const element = container.querySelector('.react-flow__edgeupdater-source') as HTMLElement | null
      if (element === null) throw new Error('edge updater anchor not rendered')
      return element
    })
    const [sx, sy] = flowToScreen(container, 320, 120)
    fireEvent.mouseDown(anchor, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseMove(document, { clientX: sx, clientY: sy })
    fireEvent.mouseUp(document, { clientX: sx, clientY: sy })

    await waitFor(() => {
      const edge = container.querySelector('.react-flow__edge')
      expect(edge?.getAttribute('aria-label')).toBe('Edge from end to end')
    })
  })

  it('renames an edge label on double-click and submits the new content', async () => {
    const setDraft = vi.fn()
    const submit = vi.fn()
    render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: canvasPage(),
    }, 'plain', { setDraft, submit })} />)

    // The label chip materializes with the (asynchronous) edge render; it is
    // the edge's only copy of the label text.
    const chip = await waitFor(() => {
      const element = screen.queryByText('then') as HTMLElement | null
      if (element === null) throw new Error('edge label chip not rendered')
      return element
    })
    fireEvent.doubleClick(chip)
    const input = screen.getByLabelText('连线文字')
    expect((input as HTMLInputElement).value).toBe('then')

    fireEvent.change(input, { target: { value: '然后' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // The chip shows the committed text instead of the input.
    expect(screen.getByText('然后')).toBeTruthy()
    expect(screen.queryByLabelText('连线文字')).toBeNull()

    fireEvent.submit(screen.getByText('Plan a flow').closest('form')!)
    expect(setDraft).toHaveBeenCalledWith(JSON.stringify({
      a2uiSubmit: {
        surfaceId: 'a2ui-1',
        graph: {
          nodes: [
            { id: 'start', label: 'Start', position: { x: 0, y: 0 }, role: 'start' },
            { id: 'end', label: 'End', position: { x: 200, y: 100 }, role: 'end' },
          ],
          edges: [{ id: 'e1', source: 'start', target: 'end', label: '然后' }],
        },
      },
    }))
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('starts an edge rename by double-clicking the line itself, not the chip', async () => {
    const { container } = render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: canvasPage(),
    })} />)

    // The transparent hit path spans the whole stroke so any double-click on
    // the line starts a rename; it is the only edge path with a transparent
    // stroke (BaseEdge's own interaction path sets strokeOpacity instead).
    const hitPath = await waitFor(() => {
      const hit = [...container.querySelectorAll('.react-flow__edge path')]
        .find(path => path.getAttribute('stroke') === 'transparent') as SVGPathElement | undefined
      if (hit === undefined) throw new Error('edge hit path not rendered')
      return hit
    })
    expect(hitPath.getAttribute('stroke-width')).toBe('16')

    fireEvent.doubleClick(hitPath)
    expect(screen.getByLabelText('连线文字')).toBeTruthy()
  })

  it('cancels an edge rename on Escape without touching the label', async () => {
    render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: canvasPage(),
    })} />)

    const chip = await waitFor(() => {
      const element = screen.queryByText('then') as HTMLElement | null
      if (element === null) throw new Error('edge label chip not rendered')
      return element
    })
    fireEvent.doubleClick(chip)
    const input = screen.getByLabelText('连线文字')
    fireEvent.change(input, { target: { value: '不要这个' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.getByText('then')).toBeTruthy()
    expect(screen.queryByText('不要这个')).toBeNull()
    expect(screen.queryByLabelText('连线文字')).toBeNull()
  })

  it('drops a blank edge label on commit without touching the line', async () => {
    render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: canvasPage(),
    })} />)

    const chip = await waitFor(() => {
      const element = screen.queryByText('then') as HTMLElement | null
      if (element === null) throw new Error('edge label chip not rendered')
      return element
    })
    fireEvent.doubleClick(chip)
    const input = screen.getByLabelText('连线文字')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByText('then')).toBeTruthy()
    expect(screen.queryByLabelText('连线文字')).toBeNull()
  })

  it('renders no label chip for an edge without a label', async () => {
    const { container } = render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: canvasPage({
        edges: [
          { id: 'e1', source: 'start', target: 'end', label: 'then' },
          { id: 'e2', source: 'end', target: 'start' },
        ],
      }),
    })} />)

    await waitFor(() => { expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(2) })
    // Only the labelled edge draws a chip inside the edge-label renderer; the
    // unlabelled one renders nothing.
    await waitFor(() => { expect(container.querySelectorAll('.react-flow__edgelabel-renderer > div')).toHaveLength(1) })
  })

  it('labels an unlabelled line on double-click and keeps its sibling untouched', async () => {
    const { container } = render(<A2uiPanel {...panelProps({
      seq: 2,
      surfaceId: 'a2ui-1',
      page: canvasPage({
        edges: [
          { id: 'e1', source: 'start', target: 'end', label: 'then' },
          { id: 'e2', source: 'end', target: 'start' },
        ],
      }),
    })} />)

    // The unlabelled edge still carries the transparent hit path, so a
    // double-click anywhere on it starts a rename from an empty draft.
    const hitPath = await waitFor(() => {
      const edge = container.querySelector('.react-flow__edge[data-id="e2"]')
      const hit = edge === null
        ? undefined
        : [...edge.querySelectorAll('path')]
          .find(path => path.getAttribute('stroke') === 'transparent')
      if (hit === undefined) throw new Error('unlabelled edge hit path not rendered')
      return hit
    })
    fireEvent.doubleClick(hitPath)
    const input = screen.getByLabelText('连线文字')
    expect((input as HTMLInputElement).value).toBe('')

    fireEvent.change(input, { target: { value: '回流' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // The renamed edge shows its new label; the labelled sibling is intact.
    expect(screen.getByText('回流')).toBeTruthy()
    expect(screen.getByText('then')).toBeTruthy()
  })
})

async function runtimeSlotRoot(ctx: Context): Promise<void> {
  ctx.slots.register({
    name: 'root',
    children: { 'conversation.chat.node': {
      kind: 'keyed',
      scope: 'session',
      inject: { hooks: { turnData: () => () => undefined } },
    } },
  } as never, () => null)
}

describe('plugin lifecycle', () => {
  it('registers the Definition and keyed renderer with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    new UiConversation(ctx, { binding: () => undefined } as never)
    ctx.provide('sessions', { list: { getSnapshot: () => ({ current: undefined, rows: [] }), subscribe: () => () => {} } } as never)
    ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    await runtimeSlotRoot(ctx)
    ctx.provide('locale', new LocaleRuntime(ctx))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.uiConversation.events.entries().map(entry => entry.kind)).toEqual(['a2ui-surface'])
    expect(ctx.slots.entries('conversation.chat.node')).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.slots.entries('conversation.chat.node')).toEqual([])
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
