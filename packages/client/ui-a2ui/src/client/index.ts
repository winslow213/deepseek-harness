/** Browser plugin for model-authored A2UI form-page Chat nodes. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { A2uiPanel } from './A2uiPanel.tsx'
import { a2uiSurfaceDefinition } from './a2ui-definition.ts'
import { en, NS, type A2uiKey, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** A2UI form-page node copy. */
    a2ui: A2uiKey
  }
}

/** Required services for Definition, keyed renderer, and copy. */
export const inject = ['conversationEvents', 'slots', 'sessions', 'locale']

/** Register the A2UI Definition, dictionary, and keyed Chat renderer. */
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(a2uiSurfaceDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-a2ui: dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'a2ui-surface',
    locale: NS,
  }, A2uiPanel))
}
