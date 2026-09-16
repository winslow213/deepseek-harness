/**
 * Feishu/Lark operator notification for account registrations.
 *
 * Registration approvals are delivered to the operator's Feishu account: the
 * account service mints a single-use token, embeds it in an approval link, and
 * sends the operator one text message naming the applicant and the link. Until
 * the operator acts there is no account, so a lost notification is a refused
 * request rather than a silently created one.
 *
 * Credentials come from the existing `dsh-feishu` integration under the
 * operator's DSH_HOME (`integrations/dsh-feishu/config.json` plus the app-secret
 * reference in `.credentials.yaml`), or from `TEAM_FEISHU_*` environment
 * variables that override them. The service runs as the operator, so no extra
 * grant is needed to read them.
 *
 * @module dsh-team-shell/account/feishu
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { usersRoot } from '../spawn-user.ts'

/** The DSH_HOME name owning the `dsh-feishu` integration the service notifies through. */
const FEISHU_INTEGRATION_OWNER = 'winslow'

/** Where the tenant access token is minted, by tenant domain. */
const TOKEN_ENDPOINTS = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
} as const

/** Resolved credentials and delivery target for operator notifications. */
export interface FeishuConfig {
  /** Bot application id (`cli_...`). */
  readonly appId: string
  /** Bot application secret. */
  readonly appSecret: string
  /** Operator open id the notification is sent to. */
  readonly ownerOpenId: string
  /** Tenant domain: mainland Feishu or Lark. */
  readonly domain: 'feishu' | 'lark'
}

/** One bot entry as the integration writes it; only the read fields are typed. */
interface BotEntry {
  appId?: unknown
  secretRef?: unknown
  ownerOpenIds?: unknown
  domain?: unknown
}

/** Strip one layer of matching YAML quotes from a scalar. */
function unquoteYamlScalar(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1)
  }
  return value
}

/**
 * Read one string value from the top-level `refs:` map of a credentials file.
 * The file is a flat `refs:` map of scalars, so a line scan avoids pulling a
 * full YAML parser into the account service.
 * @param path - the credentials file to read.
 * @param ref - the reference name to look up.
 * @returns the referenced value, or undefined when absent, null, or unreadable.
 */
function readCredentialRef(path: string, ref: string): string | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  let inRefs = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      inRefs = trimmed === 'refs:'
      continue
    }
    if (!inRefs) continue
    const sep = line.indexOf(':')
    if (sep < 0 || line.slice(0, sep).trim() !== ref) continue
    const value = unquoteYamlScalar(line.slice(sep + 1).trim())
    return value === '' || value === 'null' || value === '~' ? undefined : value
  }
  return undefined
}

/**
 * Resolve the notification credentials from the environment, falling back to
 * the `dsh-feishu` integration the operator configured under their DSH_HOME.
 * @param env - environment carrying `TEAM_FEISHU_*` overrides and `DSH_USERS_ROOT`.
 * @returns the resolved credentials, or undefined when no integration is configured.
 */
export function loadFeishuConfig(env: NodeJS.ProcessEnv = process.env): FeishuConfig | undefined {
  const envAppId = env.TEAM_FEISHU_APP_ID
  const envSecret = env.TEAM_FEISHU_APP_SECRET
  const envOwner = env.TEAM_FEISHU_OWNER_OPEN_ID
  if (envAppId !== undefined && envSecret !== undefined && envOwner !== undefined
    && envAppId !== '' && envSecret !== '' && envOwner !== '') {
    return {
      appId: envAppId,
      appSecret: envSecret,
      ownerOpenId: envOwner,
      domain: env.TEAM_FEISHU_DOMAIN === 'lark' ? 'lark' : 'feishu',
    }
  }

  const home = join(usersRoot(env), env.TEAM_FEISHU_INTEGRATION_OWNER ?? FEISHU_INTEGRATION_OWNER)
  let bots: BotEntry[]
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'integrations', 'dsh-feishu', 'config.json'), 'utf8')) as { bots?: unknown }
    if (!Array.isArray(parsed.bots)) return undefined
    bots = parsed.bots as BotEntry[]
  } catch {
    return undefined
  }

  const credentialsPath = join(home, '.credentials.yaml')
  for (const bot of bots) {
    // A bot whose app secret is missing cannot mint a token; try the next entry
    // rather than failing the whole lookup on a stale record.
    if (typeof bot.appId !== 'string' || typeof bot.secretRef !== 'string') continue
    const appSecret = readCredentialRef(credentialsPath, bot.secretRef)
    if (appSecret === undefined) continue
    if (!Array.isArray(bot.ownerOpenIds)) continue
    const ownerOpenId = bot.ownerOpenIds.find((id): id is string => typeof id === 'string' && id !== '')
    if (ownerOpenId === undefined) continue
    return {
      appId: bot.appId,
      appSecret,
      ownerOpenId,
      domain: bot.domain === 'lark' ? 'lark' : 'feishu',
    }
  }
  return undefined
}

/** A failure delivering an operator notification. */
export class FeishuNotifyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeishuNotifyError'
  }
}

/** Mint a tenant access token for the configured bot. */
async function tenantAccessToken(config: FeishuConfig): Promise<string> {
  const res = await fetch(`${TOKEN_ENDPOINTS[config.domain]}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await res.json() as { code?: unknown; msg?: unknown; tenant_access_token?: unknown }
  if (body.code !== 0 || typeof body.tenant_access_token !== 'string') {
    throw new FeishuNotifyError(`feishu token request failed: code=${String(body.code)} msg=${String(body.msg)}`)
  }
  return body.tenant_access_token
}

/**
 * Send one plain-text message to the operator.
 * @param config - resolved bot credentials and operator open id.
 * @param text - the message body.
 * @throws FeishuNotifyError when the bot cannot be authenticated or the send is rejected.
 */
export async function sendOperatorText(config: FeishuConfig, text: string): Promise<void> {
  const token = await tenantAccessToken(config)
  const res = await fetch(`${TOKEN_ENDPOINTS[config.domain]}/open-apis/im/v1/messages?receive_id_type=open_id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: config.ownerOpenId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await res.json() as { code?: unknown; msg?: unknown }
  if (body.code !== 0) {
    throw new FeishuNotifyError(`feishu send failed: code=${String(body.code)} msg=${String(body.msg)}`)
  }
}
