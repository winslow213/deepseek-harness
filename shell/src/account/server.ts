/** Account service entry: HTTP API over Postgres + Redis. */

import { Redis } from 'ioredis'
import { createDb } from './db.ts'
import { UserStore } from './users.ts'
import { InstanceStore } from './instances.ts'
import { InstanceManager } from './instance-manager.ts'
import { SessionStore } from './session.ts'
import { PairingStore } from './pairings.ts'
import { AuthService } from './auth.ts'
import { createAccountServer } from './http.ts'
import { loadEnv } from './env.ts'
import { RegistrationService } from './registrations.ts'
import { FeishuNotifyError, loadFeishuConfig, sendOperatorText } from './feishu.ts'

/** Boot the account service (HTTP API + instance lifecycle) and hold it open. */
export async function main(): Promise<void> {
  const env = loadEnv()
  const db = await createDb(env.dbUrl)
  const redis = new Redis(env.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 })
  await redis.connect()
  await redis.ping()

  const users = new UserStore(db)
  const instances = new InstanceStore(db)
  const sessions = new SessionStore(redis, env.sessionTtlSecs)
  const pairings = new PairingStore(redis, env.pairingTtlSecs * 1000)
  const auth = new AuthService(users, sessions)
  const lifecycle = new InstanceManager({
    instances,
    users,
    portStart: env.portStart,
    portEnd: env.portEnd,
    idleTimeoutSecs: env.idleTimeoutSecs,
  })

  const feishu = loadFeishuConfig()
  if (feishu === undefined) {
    // Login and every existing account keep working without a notification
    // channel, but no registration can be approved, so say so once at boot
    // instead of leaving applicants waiting on a request nobody sees.
    console.error('[team-account] no Feishu integration found; account registration cannot notify the operator')
  }
  const registrations = new RegistrationService(db, users, {
    domains: env.registrationDomains,
    defaultPassword: env.defaultPassword,
    ttlSecs: env.registrationTtlSecs,
    entryBaseUrl: env.entryBaseUrl,
    notify: async (text) => {
      if (feishu === undefined) throw new FeishuNotifyError('no Feishu integration is configured')
      await sendOperatorText(feishu, text)
    },
  })

  const server = createAccountServer({
    auth, sessions, users, instances, pairings, lifecycle, registrations,
    sessionTtlSecs: env.sessionTtlSecs,
    registrationDomains: env.registrationDomains,
    defaultPassword: env.defaultPassword,
    adminSecret: env.adminSecret,
  })
  server.listen(env.httpPort, '127.0.0.1', () => {
    console.log(`[team-account] listening on http://127.0.0.1:${String(env.httpPort)}`)
  })

  /**
   * Bring back accounts that must stay up, and name each one in the log.
   *
   * Instances die with this process, so a restart is exactly when the
   * keep-alive set has to be restored; `InstanceManager.keepAlive` owns which
   * accounts those are and is reused by the periodic sweep. Running it after
   * `listen` keeps a slow spawn off the API's startup path, and it also runs
   * provisioning, so new per-account plugin files and patch blocks reach
   * accounts nobody has signed into yet.
   */
  void lifecycle.keepAlive()

  const shutdown = async (code: number): Promise<void> => {
    server.close()
    await lifecycle.stopAll()
    await redis.quit().catch(() => {})
    await db.end().catch(() => {})
    process.exit(code)
  }
  process.on('SIGTERM', () => { void shutdown(0) })
  process.on('SIGINT', () => { void shutdown(130) })
}
