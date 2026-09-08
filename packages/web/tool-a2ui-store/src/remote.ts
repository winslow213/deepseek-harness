/**
 * Host Remote owner for the A2UI tool store: exposes the saved-tool list and
 * a direct "open" that re-renders a saved page by appending a fresh
 * `a2ui/surface` event to the addressed session (the same durable event the
 * `a2ui_surface` tool appends), so the existing renderer draws it without a
 * model round-trip.
 * @module @deepseek-ai/dsh-tool-a2ui-store/remote
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `agents` Context merge and the Agent `session` augmentation.
import type {} from '@deepseek-ai/dsh-agent'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  A2uiStoreDeleteRequest, A2uiStoreDeleteValue,
  A2uiStoreListValue, A2uiStoreOpenRequest, A2uiStoreOpenValue,
} from './types.ts'

export type {
  A2uiStoreDeleteRequest, A2uiStoreDeleteValue,
  A2uiStoreListValue, A2uiStoreOpenRequest, A2uiStoreOpenValue,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `a2uiStore` Remote namespace. */
    a2uiStoreController: A2uiStoreController
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The addressed session has no live agent to re-render into. */
    'a2ui-store/agent-offline': { readonly sessionId: string }
    /** No saved tool exists under that name. */
    'a2ui-store/not-found': { readonly name: string }
  }
}

/** Mint a fresh surface identity for a re-rendered saved tool. */
function mintSurfaceId(): string {
  return `a2ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Host service backing `ctx.remote.a2uiStore`: list saved tools, re-render one
 * into a session, and remove one.
 */
export class A2uiStoreController extends TypertRemoteService {
  static inject = ['a2uiStore', 'agents', 'typert']

  /** @param ctx - Host context carrying the store capability and the agent registry. */
  constructor(ctx: Context) {
    super(ctx, 'a2uiStoreController', { namespace: 'a2uiStore' })
  }

  /**
   * List every saved tool (name, page, savedAt).
   * @returns the saved tools, name-sorted.
   */
  @Remote('list')
  async list(): Promise<A2uiStoreListValue> {
    return { tools: await this.ctx.a2uiStore.list() }
  }

  /**
   * Re-render one saved tool into the addressed session by appending a fresh
   * `a2ui/surface` event carrying its page. The owning agent must be live; the
   * client then renders it through the existing A2UI surface projection.
   * @param request - session identity and the saved tool name.
   * @returns the minted surface identity and the tool name.
   */
  @Remote('open')
  async open(request: A2uiStoreOpenRequest): Promise<A2uiStoreOpenValue> {
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      throw new RemoteError('a2ui-store/agent-offline', `no agent for session "${request.sessionId}"`, { sessionId: request.sessionId })
    }
    const tools = await this.ctx.a2uiStore.list()
    const tool = tools.find(record => record.name === request.name)
    if (tool === undefined) {
      throw new RemoteError('a2ui-store/not-found', `no saved tool named "${request.name}"`, { name: request.name })
    }
    const surfaceId = mintSurfaceId()
    agent.session.append('a2ui/surface', { surfaceId, page: tool.page })
    return { surfaceId, name: tool.name }
  }

  /**
   * Delete one saved tool.
   * @param request - the tool name.
   * @returns whether a tool was deleted.
   */
  @Remote('delete')
  async delete(request: A2uiStoreDeleteRequest): Promise<A2uiStoreDeleteValue> {
    const removed = await this.ctx.a2uiStore.remove(request.name)
    return { removed }
  }
}
