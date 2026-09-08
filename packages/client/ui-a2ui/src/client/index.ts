/** Browser plugin for model-authored A2UI form-page Chat nodes. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `remote` Context merge so the run bridge below reaches
// `ctx.remote.a2uiRun` (the host namespace is mounted by api-remotes).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { A2uiLauncher, type A2uiRunBridge } from './launcher.tsx'
import { a2uiSurfaceDefinition } from './a2ui-definition.ts'
import { en, NS, type A2uiKey, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** A2UI form-page node copy. */
    a2ui: A2uiKey
  }
}

/** Required services for Definition, keyed renderer, copy, and the command-run Remote. */
export const inject = ['uiConversation', 'slots', 'sessions', 'locale', 'remote', 'remote.a2uiRun']

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
    inject: () => ({ bridge: buildBridge(ctx) }),
  }, A2uiLauncher))
}
