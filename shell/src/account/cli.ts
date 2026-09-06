/** Operator CLI: create members, list users, rotate agent tokens. */

import { Redis } from 'ioredis'
import { createDb } from './db.ts'
import { UserStore } from './users.ts'
import { loadEnv } from './env.ts'

function usage(): never {
  process.stderr.write(
    [
      'usage: dsh-shell account-cli <command>',
      '  create-user <username> <password> [--operator]   create a member (or operator) account',
      '  list-users                                       list accounts',
      '  reset-agent-token <username>                     rotate a user\'s agent token',
      '  reset-password <username> <password>             set a new password',
    ].join('\n') + '\n',
  )
  process.exit(1)
}

export async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv
  const env = loadEnv()
  const db = await createDb(env.dbUrl)
  const users = new UserStore(db)
  const redis = new Redis(env.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 })
  try {
    switch (command) {
      case 'create-user': {
        const username = args[0]
        const password = args[1]
        const operator = args.includes('--operator')
        if (username === undefined || password === undefined) usage()
        const user = await users.create({
          username,
          password,
          role: operator ? 'operator' : 'member',
        })
        console.log(`created ${user.username} (${user.role}) user_id=${user.user_id}`)
        console.log(`agent_token=${user.agent_token}`)
        break
      }
      case 'list-users': {
        const rows = await users.list()
        for (const u of rows) {
          console.log(`${u.username}\t${u.role}\t${u.status}\tuser_id=${u.user_id}\tagent_token=${u.agent_token}`)
        }
        break
      }
      case 'reset-agent-token': {
        const username = args[0]
        if (username === undefined) usage()
        const user = await users.findByUsername(username)
        if (user === undefined) {
          console.error(`no such user ${JSON.stringify(username)}`)
          process.exitCode = 1
          break
        }
        const token = await users.rotateAgentToken(user.user_id)
        console.log(`new agent_token for ${username}: ${token}`)
        break
      }
      case 'reset-password': {
        const username = args[0]
        const password = args[1]
        if (username === undefined || password === undefined) usage()
        const user = await users.findByUsername(username)
        if (user === undefined) {
          console.error(`no such user ${JSON.stringify(username)}`)
          process.exitCode = 1
          break
        }
        await users.setPassword(user.user_id, password)
        console.log(`password reset for ${username}`)
        break
      }
      default:
        usage()
    }
  } finally {
    await redis.quit().catch(() => {})
    await db.end().catch(() => {})
  }
}
