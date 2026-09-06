/**
 * Team Shell Sign out row plugin, browser half: one General-settings row that
 * posts to the same-origin `/api/logout` and navigates to `/`. The row
 * registers through the settings slot only as a cell — the entry itself is
 * locale-owned and gated at render time on the team-shell marker, so plain
 * single-user dsh documents (no marker) keep the General section unchanged.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings slot types (this package registers a General row).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.slots merge (the SlotRegistry service face).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TeamAccountRow } from './TeamAccountRow.tsx'
import { PairingRow } from './PairingRow.tsx'
import { en, zh, type TeamAccountLocaleKey } from './locales.ts'

export type { TeamAccountRowProps } from './TeamAccountRow.tsx'
export type { PairingRowProps } from './PairingRow.tsx'
export type { TeamAccountLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sign out + pairing code row copy. */
    'settings.teamAccount': TeamAccountLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.teamAccount'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Contribute the Pairing code and Sign out rows to the General settings section.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-team-account: dictionaries')

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'team-pairing',
    order: 90,
    locale: NS,
  }, PairingRow))

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'team-account',
    order: 100,
    locale: NS,
  }, TeamAccountRow))
}
