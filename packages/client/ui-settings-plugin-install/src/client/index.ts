/** Operator-gated plugin install tab registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PluginInstallSettingsTab, type PluginInstallSettingsTabInjected } from './PluginInstallSettingsTab.tsx'
import { en, zh, type PluginInstallLocaleKey } from './locales.ts'

export type { PluginInstallSettingsTabInjected, PluginInstallSettingsTabProps } from './PluginInstallSettingsTab.tsx'
export type { PluginInstallLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Operator-facing plugin install copy. */
    'settings.pluginInstall': PluginInstallLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginInstall'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginInstall']

/** Contribute the plugin install tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugin-install: dictionaries')

  const t = ctx.locale.bind(NS)
  const installPlugin: PluginInstallSettingsTabInjected['installPlugin'] = async (spec) => {
    const result = await ctx.remote.pluginInstall.installPlugin(spec)
    if (!result.ok) {
      // Attach the Remote error code so the section can render it as-is.
      const error = new Error(result.error.message)
      ;(error as { code?: string }).code = result.error.code
      throw error
    }
    return result.value
  }
  const injected = (): PluginInstallSettingsTabInjected => ({ installPlugin })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'plugin-install',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PluginInstallSettingsTab))
}
