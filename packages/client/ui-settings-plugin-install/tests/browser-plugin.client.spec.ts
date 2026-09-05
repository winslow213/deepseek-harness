/**
 * Registration: the install tab entry, its locale-following label, and the
 * Remote failure mapping all come from one apply, and the tab defers until
 * the Plugins section slot has been declared.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { PluginInstallSpec } from '@deepseek-ai/dsh-api-remotes/client'
import { apply, inject } from '../src/client/index.ts'
import { PluginInstallSettingsTab } from '../src/client/PluginInstallSettingsTab.tsx'
import { zh } from '../src/client/locales.ts'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const installPlugin = (_spec: PluginInstallSpec) => Promise.resolve({
    ok: true as const,
    value: { form: 'npm-bundle' as const, profileDir: '/tmp/profile', bundlesAdded: ['@scope/pkg'] },
  })
  const remote = new TestRemote(ctx, { pluginInstall: { installPlugin } })
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, remote }
}

/** The Plugins section owner's slot declaration, staged by hand. */
function declarePluginsTab(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'settings.plugins.tab': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

describe('ui-settings-plugin-install apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.pluginInstall'])
  })

  it('registers the install tab after the Plugins section slot is declared', async () => {
    const { slots } = await bench()
    declarePluginsTab(slots)

    await Promise.resolve()
    const tab = slots.entries('settings.plugins.tab')[0]!
    expect(tab.component).toBe(PluginInstallSettingsTab)
    expect(tab.options).toMatchObject({ id: 'plugin-install', order: 20 })
    expect(resolveSlotLabel(tab.options.label)).toBe(zh.tab)
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { slots } = await bench()

    declarePluginsTab(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.plugins.tab')).toHaveLength(1) })
  })

  it('resolves the injected install face over the pluginInstall Remote', async () => {
    const { slots } = await bench()
    declarePluginsTab(slots)

    await Promise.resolve()
    const injected = (slots.entries('settings.plugins.tab')[0]!.inject as unknown as () => {
      installPlugin: (spec: PluginInstallSpec) => Promise<{ form: 'npm-bundle'; profileDir: string; bundlesAdded: string[] }>
    })()
    await expect(injected.installPlugin({ form: 'npm-bundle', spec: '@scope/pkg' }))
      .resolves.toEqual({ form: 'npm-bundle', profileDir: '/tmp/profile', bundlesAdded: ['@scope/pkg'] })
  })

  it('maps a Remote failure onto a rejecting install with the code attached', async () => {
    const { ctx, slots } = await bench()
    declarePluginsTab(slots)

    await Promise.resolve()
    // Re-script the Remote the same way the Host answers a refused install.
    const refusing = {
      installPlugin: () => Promise.resolve({
        ok: false as const,
        error: { code: 'plugin-install/invalid-spec' as const, message: 'relative source path' },
      }),
    }
    Object.assign(ctx.remote.pluginInstall, refusing)

    const injected = (slots.entries('settings.plugins.tab')[0]!.inject as unknown as () => {
      installPlugin: (spec: PluginInstallSpec) => Promise<unknown>
    })()
    await expect(injected.installPlugin({ form: 'file-dir', id: 'my-plugin', sourcePath: 'relative' }))
      .rejects.toMatchObject({ message: 'relative source path', code: 'plugin-install/invalid-spec' })
  })
})
