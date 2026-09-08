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

/** Required services for Definition, keyed renderer, and copy. */
export const inject = ['uiConversation', 'slots', 'sessions', 'locale']

/**
 * Build the command-run bridge from the api-remotes `a2uiRun` namespace. The
 * remote service is resolved lazily at call time, so the launcher registers
 * even in compositions that mount no remote; clicking a `command` action then
 * fails with a clear message instead of crashing at registration.
 * @param ctx - registrant context whose remote assembly may carry `a2uiRun`.
 * @returns the bridge the launcher renders against.
 */
function buildBridge(ctx: ClientContext): A2uiRunBridge {
  const remote = (): NonNullable<ClientContext['remote']['a2uiRun']> => {
    const run = ctx.remote?.a2uiRun
    if (run === undefined) {
      throw new Error('a2ui command actions need the api-remotes assembly with the a2uiRun namespace mounted')
    }
    return run
  }
  return {
    start: async (request) => {
      const run = remote()
      const answered = await run.start(request)
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
    read: async (runId) => {
      const run = remote()
      const answered = await run.read({ runId })
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
    stop: async (runId) => {
      const run = remote()
      const answered = await run.stop({ runId })
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
