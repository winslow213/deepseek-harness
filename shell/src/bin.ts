/**
 * dsh Team Shell CLI entry.
 * @module dsh-team-shell/bin
 */

import { spawnUserInstance } from './spawn-user.ts'
import { startProxy } from './reverse-proxy.ts'

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
  case 'proxy': {
    // usage: dsh-shell proxy <entryPort> <userA:portA> [userB:portB ...]
    const entryPort = Number(args[0])
    const upstreams = args.slice(1)
    if (Number.isNaN(entryPort) || upstreams.length === 0) {
      console.error('usage: dsh-shell proxy <entryPort> <user:port> [user:port ...]')
      process.exit(1)
    }
    const routes = new Map<string, { user: string; port: number }>()
    for (const spec of upstreams) {
      // `@user:port` becomes the default upstream (path passthrough);
      // `user:port` becomes a `/u/user` prefix route.
      const isDefault = spec.startsWith('@')
      const body = isDefault ? spec.slice(1) : spec
      const [user, portText] = body.split(':')
      const port = Number(portText)
      if (user === undefined || Number.isNaN(port)) {
        console.error(`invalid upstream ${JSON.stringify(spec)}; expected [@]user:port`)
        process.exit(1)
      }
      routes.set(isDefault ? '' : `/u/${user}`, { user, port })
    }
    const server = startProxy({ port: entryPort, routes })
    console.log(`proxy listening on http://127.0.0.1:${String(entryPort)}`)
    for (const [prefix, u] of routes) {
      console.log(`  ${prefix === '' ? '(default)' : prefix} -> user ${u.user} upstream ${String(u.port)}`)
    }
    process.on('SIGINT', () => { server.close(() => process.exit(0)) })
    break
  }
  default:
    console.error('usage: dsh-shell <spawn-user|proxy> ...')
    process.exit(1)
}
