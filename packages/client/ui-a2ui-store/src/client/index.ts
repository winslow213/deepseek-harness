/** Browser plugin: a sidebar footer panel listing saved A2UI tools and re-opening them. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the `remote` Context merge (`ctx.remote.a2uiStore`).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the slots Context merge and the sidebar footer-action slot.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { A2uiStorePanel } from './A2uiStorePanel.tsx'
import { en, NS, type A2uiStoreKey, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Saved A2UI tools sidebar copy. */
    a2uiStore: A2uiStoreKey
  }
}

/** Required services. */
export const inject = ['slots', 'locale', 'remote', 'remote.a2uiStore']

/**
 * Contribute the saved-A2UI-tools panel to the sidebar footer.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-a2ui-store: dictionaries')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'a2ui-store',
    locale: NS,
    inject: () => ({
      listTools: async () => {
        const answered = await ctx.remote.a2uiStore.list()
        if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
        return { tools: answered.value.tools }
      },
      openTool: async (sessionId: SessionId, name: string) => {
        const answered = await ctx.remote.a2uiStore.open({ sessionId, name })
        if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
        return answered.value
      },
      removeTool: async (name: string) => {
        const answered = await ctx.remote.a2uiStore.delete({ name })
        if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
        return { removed: answered.value.removed }
      },
    }),
  }, A2uiStorePanel))
}
