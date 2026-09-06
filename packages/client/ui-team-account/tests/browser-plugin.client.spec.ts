/**
 * ui-team-account browser half on a real cordis Context: the plugin registers
 * the Sign out row into the General section item slot once the slot is
 * declared — with its locale namespace, no inject face, and no store — and
 * registration happens regardless of the team-shell marker (the marker gates
 * the row's render, not its registration, so locale re-registration and HMR
 * keep working); fiber disposal removes the contribution (HMR safety).
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject, NS } from '../src/client/index.ts'
import { TeamAccountRow } from '../src/client/TeamAccountRow.tsx'
import { PairingRow } from '../src/client/PairingRow.tsx'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, locale, slots: ctx.get('slots') as SlotRegistry }
}

/** The General section owner's slot declaration, staged by hand. */
function declareGeneralItem(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'settings.general.item': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

/** One registered General item by id. */
function entryById(slots: SlotRegistry, id: string) {
  return slots.entries('settings.general.item').find(e => e.options.id === id)
}

describe('ui-team-account apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the Pairing code and Sign out rows under settings.general.item', async () => {
    const { slots } = await bench()
    declareGeneralItem(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.general.item')).toHaveLength(2) })
    const pairing = entryById(slots, 'team-pairing')!
    expect(pairing.component).toBe(PairingRow)
    expect(pairing.options).toEqual({ id: 'team-pairing', order: 90 })
    expect(pairing.locale).toBe(NS)

    const signOut = entryById(slots, 'team-account')!
    expect(signOut.component).toBe(TeamAccountRow)
    expect(signOut.options).toEqual({ id: 'team-account', order: 100 })
    expect(signOut.locale).toBe(NS)
  })

  it('registers its dictionary namespace with the row copy in both locales', async () => {
    const { ctx, locale } = await bench()
    const t = ctx.locale.bind(NS)
    expect(t('title')).toBe('Sign out')
    expect(t('hint')).toBe('You will need to sign in again to continue')
    expect(t('pairTitle')).toBe('Pairing code')
    locale.setLocale('zh')
    expect(t('title')).toBe('退出登录')
    expect(t('hint')).toBe('退出后需重新登录才能继续使用')
    expect(t('pairTitle')).toBe('生成配对码')
  })

  it('registers without the team-shell marker (the marker gates rendering, not registration)', async () => {
    const { slots } = await bench()
    declareGeneralItem(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.general.item')).toHaveLength(2) })
  })

  it('disposal removes both rows (HMR safety)', async () => {
    const b = await bench()
    declareGeneralItem(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.general.item')).toHaveLength(2) })

    await b.fiber.dispose()
    expect(b.slots.entries('settings.general.item')).toHaveLength(0)
  })
})
