/**
 * dsh Team Shell CLI entry.
 * @module dsh-team-shell/bin
 */

import { spawnUserInstance } from './spawn-user.ts'

const [, , command, ...args] = process.argv

switch (command) {
  case 'spawn-user': {
    const user = args[0]
    const port = Number(args[1])
    if (user === undefined || Number.isNaN(port)) {
      console.error('usage: dsh-shell spawn-user <user> <port>')
      process.exit(1)
    }
    const instance = spawnUserInstance(user, port)
    instance.url.then((url) => {
      console.log(`USER URL: ${url}`)
    }).catch((error: unknown) => {
      console.error(`spawn failed: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    })
    process.on('SIGINT', () => { void instance.dispose().then(() => process.exit(0)) })
    break
  }
  default:
    console.error('usage: dsh-shell <spawn-user> <user> <port>')
    process.exit(1)
}
