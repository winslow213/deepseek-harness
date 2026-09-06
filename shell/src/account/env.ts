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
  /** Inclusive instance port range. */
  portStart: number
  portEnd: number
  /** Lifetime of a minted pairing code, in seconds (default 30 minutes). */
  pairingTtlSecs: number
  /** Idle timeout after which a member's instance is reclaimed (default 30 minutes). */
  idleTimeoutSecs: number
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
  const rawPortStart = env.TEAM_INSTANCE_PORT_START ?? '32001'
  const rawPortEnd = env.TEAM_INSTANCE_PORT_END ?? '60999'
  const portStart = Number(rawPortStart)
  const portEnd = Number(rawPortEnd)
  if (!Number.isInteger(portStart) || portStart <= 0 || portStart > 65535
    || !Number.isInteger(portEnd) || portEnd < portStart || portEnd > 65535) {
    throw new Error(`TEAM_INSTANCE_PORT_START/END must define an inclusive port range; got ${JSON.stringify(rawPortStart)}-${JSON.stringify(rawPortEnd)}`)
  }
  const rawPairingTtl = env.TEAM_PAIRING_TTL_SECS ?? String(30 * 60)
  const pairingTtlSecs = Number(rawPairingTtl)
  if (Number.isNaN(pairingTtlSecs) || pairingTtlSecs <= 0) {
    throw new Error(`TEAM_PAIRING_TTL_SECS must be a positive number; got ${JSON.stringify(rawPairingTtl)}`)
  }
  const rawIdle = env.TEAM_IDLE_TIMEOUT_SECS ?? String(30 * 60)
  const idleTimeoutSecs = Number(rawIdle)
  if (Number.isNaN(idleTimeoutSecs) || idleTimeoutSecs <= 0) {
    throw new Error(`TEAM_IDLE_TIMEOUT_SECS must be a positive number; got ${JSON.stringify(rawIdle)}`)
  }
  return {
    dbUrl, redisUrl, httpPort, sessionTtlSecs, agentTokenBytes,
    adminSecret: adminSecret === '' ? undefined : adminSecret,
    portStart, portEnd, pairingTtlSecs, idleTimeoutSecs,
  }
}
