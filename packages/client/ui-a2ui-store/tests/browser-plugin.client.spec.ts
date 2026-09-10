/**
 * ui-a2ui-store browser half on a real cordis Context: the plugin registers
 * the saved-tools panel into the sidebar footer-action slot once that slot is
 * declared — with its locale namespace and an inject face that forwards to the
 * a2uiStore Remote — and fiber disposal removes the contribution (HMR safety).
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { NS } from '../src/client/locales.ts'
import { A2uiStorePanel } from '../src/client/A2uiStorePanel.tsx'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const list = vi.fn(async () => ({ ok: true as const, value: { tools: [] } }))
  const open = vi.fn(async () => ({ ok: true as const, value: { surfaceId: 's', name: 'n' } }))
  const remove = vi.fn(async () => ({ ok: true as const, value: { removed: true } }))
  const share = vi.fn(async () => ({ ok: true as const, value: { name: 'n', token: 'a2ui-share:abc' } }))
  const import_ = vi.fn(async () => ({ ok: true as const, value: { name: 'n', imported: true } }))
  new TestRemote(ctx, { a2uiStore: { list, open, delete: remove, share, import: import_ } })
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, locale, slots: ctx.get('slots') as SlotRegistry, list, open, remove, share, import: import_ }
}

/** The sidebar shell's slot declaration, staged by hand. */
function declareFooterAction(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

/** The registered saved-tools entry by id. */
function entryById(slots: SlotRegistry, id: string) {
  return slots.entries('sidebar.footer.action').find(e => e.options.id === id)
}

describe('ui-a2ui-store apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.a2uiStore'])
  })

  it('registers the saved-tools panel under sidebar.footer.action', async () => {
    const { slots } = await bench()
    declareFooterAction(slots)

    await vi.waitFor(() => { expect(slots.entries('sidebar.footer.action')).toHaveLength(1) })
    const entry = entryById(slots, 'a2ui-store')!
    expect(entry.component).toBe(A2uiStorePanel)
    expect(entry.locale).toBe(NS)
  })

  it('forwards the inject face to the a2uiStore Remote', async () => {
    const { slots, list, open, remove, share, import: import_ } = await bench()
    declareFooterAction(slots)
    await vi.waitFor(() => { expect(slots.entries('sidebar.footer.action')).toHaveLength(1) })

    const face = entryById(slots, 'a2ui-store')!.inject!() as {
      listTools: () => Promise<unknown>
      openTool: (sessionId: string, name: string) => Promise<unknown>
      removeTool: (name: string) => Promise<unknown>
      shareTool: (name: string) => Promise<unknown>
      importTool: (token: string) => Promise<unknown>
    }
    await face.listTools()
    expect(list).toHaveBeenCalledOnce()

    await face.openTool('session', 'hilog-capture')
    expect(open).toHaveBeenCalledWith({ sessionId: 'session', name: 'hilog-capture' })

    await face.removeTool('hilog-capture')
    expect(remove).toHaveBeenCalledWith({ name: 'hilog-capture' })

    await face.shareTool('hilog-capture')
    expect(share).toHaveBeenCalledWith({ name: 'hilog-capture' })

    await face.importTool('a2ui-share:abc')
    expect(import_).toHaveBeenCalledWith({ token: 'a2ui-share:abc' })
  })

  it('registers its dictionary namespace in both locales', async () => {
    const { ctx, locale } = await bench()
    const t = ctx.locale.bind(NS)
    expect(t('panel.title')).toBe('A2UI tools')
    locale.setLocale('zh')
    expect(t('panel.title')).toBe('A2UI 工具')
    expect(t('row.remove')).toBe('删除')
    expect(t('row.share')).toBe('分享')
    expect(t('panel.import')).toBe('导入')
  })

  it('disposal removes the panel (HMR safety)', async () => {
    const b = await bench()
    declareFooterAction(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('sidebar.footer.action')).toHaveLength(1) })

    await b.fiber.dispose()
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)
  })
})
