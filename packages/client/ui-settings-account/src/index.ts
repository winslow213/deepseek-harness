/** Host configuration for the account settings client. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { type AccountConfig, AccountConfigFields, ACCOUNT_CONFIG_GLOBAL } from './account-config.ts'
import z from '@deepseek-ai/schemastery'
import { OnboardingSettingsFields, type OnboardingStep, type OnboardingPurpose, type OnboardingProcess } from './onboarding-settings.ts'
/** Bonus-notice retry options and live device-local onboarding progress. */
export interface Config extends AccountConfig {
  /** Onboarding progress format version. */
  version: Volatile<1>
  /** Last accepted onboarding page. */
  step: Volatile<OnboardingStep>
  /** Selected work scenario. */
  purpose?: Volatile<OnboardingPurpose | null | undefined>
  /** Selected transcript detail. */
  process?: Volatile<OnboardingProcess | null | undefined>
  /** Completion reason, absent until completion. */
  completion?: Volatile<'completed' | 'skipped' | 'api-key' | null | undefined>
  /** Selected usage detail. */
  usage: Volatile<'compact' | 'detailed'>
  /** Selected developer-tool visibility. */
  developerTools: Volatile<boolean>
}

/** Configuration projected through the account plugin's shared form. */
export const Config = z.object({
  bonusAckRetryDelayMs: AccountConfigFields.bonusAckRetryDelayMs,
  bonusAckRetryMaxDelayMs: AccountConfigFields.bonusAckRetryMaxDelayMs,
  version: OnboardingSettingsFields.version.volatile(),
  step: OnboardingSettingsFields.step.volatile(),
  purpose: OnboardingSettingsFields.purpose.volatile(),
  process: OnboardingSettingsFields.process.volatile(),
  completion: OnboardingSettingsFields.completion.volatile(),
  usage: OnboardingSettingsFields.usage.volatile(),
  developerTools: OnboardingSettingsFields.developerTools.volatile(),
})

/**
 * Publish the bonus-notice retry timings before browser plugins activate.
 * @param ctx - Host context collecting page initialization data.
 * @param config - validated deployment options.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (scope) => {
    scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber))
  })
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: ACCOUNT_CONFIG_GLOBAL, value: {
      bonusAckRetryDelayMs: config.bonusAckRetryDelayMs, bonusAckRetryMaxDelayMs: config.bonusAckRetryMaxDelayMs,
    } satisfies AccountConfig })
  })
}
