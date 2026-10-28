/** Bonus-notice retry options shared by Host and Client. */
import z from '@deepseek-ai/schemastery'

/** Retry timings for the bonus acknowledgement notice, shared by Host and Client. */
export interface AccountConfig {
  /** First delay before retrying a failed bonus acknowledgement. */
  bonusAckRetryDelayMs: number
  /** Ceiling for the acknowledgement retry backoff. */
  bonusAckRetryMaxDelayMs: number
}
/** Validate the bonus acknowledgement retry timings. */
export const AccountConfigFields = {
  bonusAckRetryDelayMs: z.number().min(1).default(1_000),
  bonusAckRetryMaxDelayMs: z.number().min(1).default(60_000),
}
/** Validate the bonus acknowledgement retry timings. */
export const AccountConfig: z<Partial<AccountConfig>, AccountConfig> = z.object(AccountConfigFields)
/** Bootstrap key carrying the notice timings to the page; it holds no account credentials. */
export const ACCOUNT_CONFIG_GLOBAL = '__DSH_ACCOUNT_CONFIG__'
