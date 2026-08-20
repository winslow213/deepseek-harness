import type {
  ChatConversationViewNode, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { A2uiPage, A2uiSurfaceData } from '@deepseek-ai/dsh-tool-a2ui-surface/types'

/** Final keyed Chat payload for one model-opened A2UI page. */
export interface A2uiSurfaceChatData {
  /** Durable log seq of the opening `a2ui/surface` event. */
  readonly seq: number
  /** Stable surface identity the submission payload correlates with. */
  readonly surfaceId: string
  /** The declarative page the panel renders as an interactive form. */
  readonly page: A2uiPage
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** One model-opened A2UI form page rendered natively in the transcript. */
    'a2ui-surface': A2uiSurfaceChatData
  }
}

/**
 * Build the collision-free Context identity for one opening event: the id
 * pairs the model-chosen `surfaceId` with the log seq, so a deliberately
 * reused `surfaceId` (an update call) opens a fresh standalone node instead
 * of colliding with an existing Context. Each opening event is its own row,
 * exactly as the log records it.
 * @param surfaceId - the durable surface identity from the event data.
 * @param seq - the opening event's log seq.
 * @returns the Definition-local Context id.
 */
function surfaceContextId(surfaceId: string, seq: number): string {
  return `${surfaceId}#${seq}`
}

/**
 * Project one durable `a2ui/surface` event into a standalone Chat node the
 * web UI renders as an interactive form. The node is log-only presentation:
 * the user's later submission reaches the model as an ordinary
 * `user/message`, so no node state changes after the page opens.
 */
export const a2uiSurfaceDefinition: ConversationNodeDefinition<A2uiSurfaceData> = {
  kind: 'a2ui-surface',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'a2ui/surface') return null
    return { id: surfaceContextId(event.data.surfaceId, event.seq), role: 'start' }
  },
  start: (_context, match) => {
    if (match.event.type !== 'a2ui/surface') {
      throw new Error('a2ui-surface start requires a2ui/surface')
    }
    return match.event.data
  },
  // Required by the Definition contract; a2ui-surface matches are always
  // `start`, so no update ever arrives and the state is returned unchanged.
  update: context => context.state,
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined || context.state === undefined) return null
    return {
      key: context.key,
      kind: 'a2ui-surface',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: {
        seq: context.start.event.seq,
        surfaceId: context.state.surfaceId,
        page: context.state.page,
      },
    }
  },
}
