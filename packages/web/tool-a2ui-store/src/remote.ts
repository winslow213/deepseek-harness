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
  A2uiRunReadRequest, A2uiRunReadValue,
  A2uiRunStartRequest, A2uiRunStartValue,
  A2uiRunStopRequest, A2uiRunStopValue,
  A2uiStoreDeleteRequest, A2uiStoreDeleteValue,
  A2uiStoreListValue, A2uiStoreOpenRequest, A2uiStoreOpenValue,
} from './types.ts'

export type {
  A2uiRunReadRequest, A2uiRunReadValue,
  A2uiRunStartRequest, A2uiRunStartValue,
  A2uiRunStopRequest, A2uiRunStopValue,
  A2uiStoreDeleteRequest, A2uiStoreDeleteValue,
  A2uiStoreListValue, A2uiStoreOpenRequest, A2uiStoreOpenValue,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `a2uiStore` Remote namespace. */
    a2uiStoreController: A2uiStoreController
    /** Host owner of the `a2uiRun` Remote namespace. */
    a2uiRunController: A2uiRunController
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The addressed session has no live agent to re-render into. */
    'a2ui-store/agent-offline': { readonly sessionId: string }
    /** No saved tool exists under that name. */
    'a2ui-store/not-found': { readonly name: string }
    /** No shell executor is mounted, so a `command` action cannot run. */
    'a2ui-run/shell-unavailable': Record<string, never>
    /** The command template or its run bound is invalid. */
    'a2ui-run/invalid-command': Record<string, never>
    /** No run exists under that identity. */
    'a2ui-run/not-found': { readonly runId: string }
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

/**
 * Host service backing `ctx.remote.a2uiRun`: start a `command`-action run on
 * the composed shell service, consume its output in chunks, and stop it.
 */
export class A2uiRunController extends TypertRemoteService {
  static inject = ['a2uiRun', 'typert']

  /** @param ctx - Host context carrying the run capability. */
  constructor(ctx: Context) {
    super(ctx, 'a2uiRunController', { namespace: 'a2uiRun' })
  }

  /**
   * Start one command run over the composed shell service.
   * @param request - the command template, collected values, and optional run bound.
   * @returns the run identity for later reads and stops.
   */
  @Remote('start')
  async start(request: A2uiRunStartRequest): Promise<A2uiRunStartValue> {
    try {
      const handle = this.ctx.a2uiRun.start(request.command, request.fields, request.timeoutMs)
      return { runId: handle.runId }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('a2uiRun: no shell')) {
        throw new RemoteError('a2ui-run/shell-unavailable', error.message, {})
      }
      if (error instanceof Error && error.message.startsWith('a2ui command action:')) {
        throw new RemoteError('a2ui-run/invalid-command', error.message, {})
      }
      throw error
    }
  }

  /**
   * Read the output produced since the previous read (consuming).
   * @param request - the run identity.
   * @returns the next output chunk and the process state.
   */
  @Remote('read')
  async read(request: A2uiRunReadRequest): Promise<A2uiRunReadValue> {
    try {
      const value = this.ctx.a2uiRun.read(request.runId)
      return { runId: request.runId, ...value }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('a2uiRun: unknown run')) {
        throw new RemoteError('a2ui-run/not-found', error.message, { runId: request.runId })
      }
      throw error
    }
  }

  /**
   * Stop one run's process group.
   * @param request - the run identity.
   * @returns whether a live process was asked to terminate.
   */
  @Remote('stop')
  async stop(request: A2uiRunStopRequest): Promise<A2uiRunStopValue> {
    try {
      const requested = this.ctx.a2uiRun.stop(request.runId)
      return { runId: request.runId, requested }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('a2uiRun: unknown run')) {
        throw new RemoteError('a2ui-run/not-found', error.message, { runId: request.runId })
      }
      throw error
    }
  }
}
