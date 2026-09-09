/** Browser plugin for model-authored A2UI form-page Chat nodes. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `remote` Context merge so the run bridge below reaches
// `ctx.remote.a2uiRun` and the notice submitter reaches `ctx.remote.session`
// (the host namespaces are mounted by api-remotes).
import type { SessionRequestId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { A2uiLauncher, type A2uiRunBridge, type A2uiSubmitNotice } from './launcher.tsx'
import { a2uiSurfaceDefinition } from './a2ui-definition.ts'
import { en, NS, type A2uiKey, zh } from './locales.ts'

/** The producer name the chat renders on the collapsed a2ui context row. */
const A2UI_SOURCE = 'a2ui'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** A2UI form-page node copy. */
    a2ui: A2uiKey
  }
}

/** Required services for Definition, keyed renderer, copy, and the command-run Remote. */
export const inject = ['uiConversation', 'slots', 'sessions', 'locale', 'remote', 'remote.a2uiRun', 'remote.session']

/**
 * Build the command-run bridge over the api-remotes `a2uiRun` namespace. The
 * namespace service is required by injection (`remote.a2uiRun`); the bridge
 * only unwraps the typed Remote results into values or thrown errors.
 * @param ctx - registrant context carrying the typed remote assembly.
 * @returns the bridge the launcher renders against.
 */
function buildBridge(ctx: ClientContext): A2uiRunBridge {
  return {
    start: async (request) => {
      const answered = await ctx.remote.a2uiRun.start(request)
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
    read: async (runId) => {
      const answered = await ctx.remote.a2uiRun.read({ runId })
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
    stop: async (runId) => {
      const answered = await ctx.remote.a2uiRun.stop({ runId })
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
    runScript: async (program, binds) => {
      const answered = await ctx.remote.a2uiRun.runScript({ program, binds, fields: {} })
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
  }
}

/**
 * Build the notice submitter over the session Remote: an A2UI action or form
 * submission reaches the model as an ordinary user-role message, but its
 * plugin `notice` source collapses the chat row instead of rendering a prompt
 * bubble. A failed admission rejects; the launcher fires and forgets it.
 * @param ctx - registrant context carrying the typed remote assembly.
 * @returns the submitter the launcher calls for actions and submissions.
 */
function buildSubmitNotice(ctx: ClientContext): A2uiSubmitNotice {
  return async (sessionId, text, summary) => {
    const answered = await ctx.remote.session.prompt({
      requestId: randomUUID() as SessionRequestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      context: { plugin: A2UI_SOURCE, form: 'notice', summary },
    }, new AbortController().signal)
    if (!answered.ok) throw new Error(`a2ui submit failed: ${answered.error.code}: ${answered.error.message}`)
  }
}

/** Register the A2UI Definition, dictionary, and keyed Chat launcher. */
export function apply(ctx: ClientContext): void {
  ctx.uiConversation.events.register(a2uiSurfaceDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-a2ui: dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'a2ui-surface',
    locale: NS,
    inject: () => ({ bridge: buildBridge(ctx), submitNotice: buildSubmitNotice(ctx) }),
  }, A2uiLauncher))
}
