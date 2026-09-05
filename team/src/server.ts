/** Account service entry: HTTP API over Postgres + Redis. */

import { Redis } from 'ioredis'
import { createDb } from './db.ts'
import { UserStore } from './users.ts'
import { InstanceStore } from './instances.ts'
import { SessionStore } from './session.ts'
import { AuthService } from './auth.ts'
import { createAccountServer } from './http.ts'
import { loadEnv } from './env.ts'

async function main(): Promise<void> {
  const env = loadEnv()
  const db = await createDb(env.dbUrl)
  const redis = new Redis(env.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 })
  await redis.connect()
  await redis.ping()

  const users = new UserStore(db)
  const instances = new InstanceStore(db)
  const sessions = new SessionStore(redis, env.sessionTtlSecs)
  const auth = new AuthService(users, sessions)

  const server = createAccountServer({ auth, sessions, users, instances, sessionTtlSecs: env.sessionTtlSecs })
  server.listen(env.httpPort, '127.0.0.1', () => {
    console.log(`[team-account] listening on http://127.0.0.1:${String(env.httpPort)}`)
  })

  const shutdown = async (code: number): Promise<void> => {
    server.close()
    await redis.quit().catch(() => {})
    await db.end().catch(() => {})
    process.exit(code)
  }
  process.on('SIGTERM', () => { void shutdown(0) })
  process.on('SIGINT', () => { void shutdown(130) })
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
