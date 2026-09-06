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
    portStart: env.portStart,
    portEnd: env.portEnd,
  })

  const server = createAccountServer({
    auth, sessions, users, instances, pairings, lifecycle,
    sessionTtlSecs: env.sessionTtlSecs,
    adminSecret: env.adminSecret,
  })
  server.listen(env.httpPort, '127.0.0.1', () => {
    console.log(`[team-account] listening on http://127.0.0.1:${String(env.httpPort)}`)
  })

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
