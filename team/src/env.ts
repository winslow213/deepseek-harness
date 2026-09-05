/** Runtime configuration for the account service, from environment variables. */

export interface EnvConfig {
  /** Postgres connection URL (team member + instance store). */
  dbUrl: string
  /** Redis connection URL (login sessions). */
  redisUrl: string
  /** Loopback HTTP port the account API listens on. */
  httpPort: number
  /** Session TTL in seconds (default 30 days, aligned with dsh browser cookie). */
  sessionTtlSecs: number
  /** Base64url length of the issued agent token (256 bits). */
  agentTokenBytes: number
  /** Shared secret operator-side services present on instance-registration calls. */
  adminSecret?: string
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const dbUrl = env.TEAM_DB_URL
  const redisUrl = env.TEAM_REDIS_URL
  if (dbUrl === undefined || dbUrl === '') {
    throw new Error('TEAM_DB_URL is required (postgresql://user:pass@host:port/db)')
  }
  if (redisUrl === undefined || redisUrl === '') {
    throw new Error('TEAM_REDIS_URL is required (redis://host:port/db)')
  }
  const rawPort = env.TEAM_HTTP_PORT ?? '3900'
  const httpPort = Number(rawPort)
  if (Number.isNaN(httpPort) || httpPort <= 0 || httpPort > 65535) {
    throw new Error(`TEAM_HTTP_PORT must be a port number; got ${JSON.stringify(rawPort)}`)
  }
  const rawTtl = env.TEAM_SESSION_TTL_SECS ?? String(30 * 24 * 60 * 60)
  const sessionTtlSecs = Number(rawTtl)
  if (Number.isNaN(sessionTtlSecs) || sessionTtlSecs <= 0) {
    throw new Error(`TEAM_SESSION_TTL_SECS must be a positive number; got ${JSON.stringify(rawTtl)}`)
  }
  const rawBytes = env.TEAM_AGENT_TOKEN_BYTES ?? '32'
  const agentTokenBytes = Number(rawBytes)
  if (Number.isNaN(agentTokenBytes) || agentTokenBytes < 16) {
    throw new Error(`TEAM_AGENT_TOKEN_BYTES must be >= 16; got ${JSON.stringify(rawBytes)}`)
  }
  const adminSecret = env.TEAM_ADMIN_SECRET
  return { dbUrl, redisUrl, httpPort, sessionTtlSecs, agentTokenBytes, adminSecret: adminSecret === '' ? undefined : adminSecret }
}
