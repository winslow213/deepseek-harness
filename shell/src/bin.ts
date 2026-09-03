/**
 * dsh Team Shell CLI entry.
 * @module dsh-team-shell/bin
 */

import { spawnUserInstance } from './spawn-user.ts'
import { startProxy } from './reverse-proxy.ts'
import { createHub, type TeamHub } from './remote/hub.ts'
import { startAgent } from './remote/agent.ts'
import { listAgents, runExec, runFsRead, type ResultFrame } from './remote/client.ts'

const [, , command, ...args] = process.argv

async function main(): Promise<void> {
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
    case 'remote': {
      const sub = args[0]
      const rest = args.slice(1)
      switch (sub) {
        case 'hub':
          await remoteHub(rest)
          break
        case 'agent':
          await startAgent(rest)
          break
        case 'agents':
          await remoteAgents(rest)
          break
        case 'exec':
          await remoteExec(rest)
          break
        case 'cat':
          await remoteCat(rest)
          break
        default:
          console.error(
            [
              'usage: dsh-shell remote <hub|agent|agents|exec|cat> ...',
              '  hub     start the hub  (see remote hub --help)',
              '  agent   start an agent  (see remote agent --help)',
              '  agents  list connected agents',
              '  exec    run a command through a user\'s agent',
              '  cat     stream a file through a user\'s agent',
            ].join('\n'),
          )
          process.exit(1)
      }
      break
    }
    default:
      console.error('usage: dsh-shell <spawn-user|proxy|remote> ...')
      process.exit(1)
  }
}

/** Parse a `--flag value` pair list into a string map; bare flags store `"true"`. */
function parseFlags(args: readonly string[]): { flags: Map<string, string>; positionals: string[] } {
  const flags = new Map<string, string>()
  const positionals: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg.startsWith('--')) {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) {
        flags.set(arg.slice(2), 'true')
      } else {
        i += 1
        flags.set(arg.slice(2), value)
      }
    } else {
      positionals.push(arg)
    }
  }
  return { flags, positionals }
}

function intFlag(flags: Map<string, string>, name: string, envName: string, fallback: number): number {
  const raw = flags.get(name) ?? process.env[envName]
  const value = raw === undefined ? fallback : Number(raw)
  if (Number.isNaN(value)) throw new Error(`${name} must be a number`)
  return value
}

function controlPort(flags: Map<string, string>): number {
  return intFlag(flags, 'control-port', 'DSH_SHELL_CONTROL_PORT', 7100)
}

function checkHelp(flags: Map<string, string>): void {
  if (flags.get('help') === 'true') {
    process.stdout.write('available flags:\n  --control-port N  (env DSH_SHELL_CONTROL_PORT, default 7100)\n')
    process.exit(0)
  }
}

async function remoteHub(args: readonly string[]): Promise<void> {
  const { flags, positionals } = parseFlags(args)
  if (flags.get('help') === 'true') {
    console.error('usage: dsh-shell remote hub --user-token user=secret[,...] [--agent-port N] [--control-port N]')
    process.exit(0)
  }
  if (positionals.length > 0) {
    console.error(`unexpected positional ${positionals[0]}`)
    process.exit(1)
  }
  const agentPort = intFlag(flags, 'agent-port', 'DSH_HUB_AGENT_PORT', 7101)
  const control = controlPort(flags)
  const tokens = new Map<string, string>()
  const pairs = flags.get('user-token')
  if (pairs !== undefined) {
    for (const pair of pairs.split(',')) {
      const [user, token] = pair.split('=')
      if (user === undefined || token === undefined) {
        console.error(`invalid --user-token ${JSON.stringify(pair)}; expected user=secret`)
        process.exit(1)
      }
      tokens.set(user, token)
    }
  }
  if (tokens.size === 0) {
    console.error('usage: dsh-shell remote hub --user-token user=secret[,...] [--agent-port N] [--control-port N]')
    process.exit(1)
  }
  const hub = createHub({ agentPort, controlPort: control, tokens })
  console.log(`hub agent listener on 0.0.0.0:${String(agentPort)}`)
  console.log(`hub control API on http://127.0.0.1:${String(control)}`)
  process.on('SIGINT', () => { void hub.close().then(() => process.exit(0)) })
  await keepAlive(hub)
}

/** Resolve when a long-lived service is asked to stop. */
function keepAlive(hub: TeamHub): Promise<void> {
  return new Promise((resolve) => {
    process.on('SIGTERM', () => { void hub.close().then(resolve) })
  })
}

async function remoteAgents(args: readonly string[]): Promise<void> {
  const { flags, positionals } = parseFlags(args)
  checkHelp(flags)
  if (positionals.length > 0) {
    console.error(`unexpected positional ${positionals[0]}`)
    process.exit(1)
  }
  const agents = await listAgents(controlPort(flags))
  console.log(JSON.stringify(agents, null, 2))
}

/** Print a hub result frame; returns true when the exchange ended in an error. */
function framePrinter(out: NodeJS.WritableStream, errOut: NodeJS.WritableStream): (frame: ResultFrame) => void {
  return (frame) => {
    if (frame.type === 'stream') {
      if (frame.channel === 'data' || frame.channel === 'stdout') out.write(frame.data)
      else errOut.write(frame.data)
    } else if (frame.type === 'request-error') {
      errOut.write(`remote error: ${frame.message}\n`)
    }
  }
}

async function remoteExec(args: readonly string[]): Promise<void> {
  const { flags, positionals } = parseFlags(args)
  checkHelp(flags)
  const user = positionals[0]
  const argv = positionals.slice(1)
  if (user === undefined || argv.length === 0) {
    console.error('usage: dsh-shell remote exec [--control-port N] <user> <command> [arg...]')
    process.exit(1)
  }
  let exitCode: number | null = null
  let failed = false
  try {
    await runExec(controlPort(flags), { user, argv }, (frame) => {
      if (frame.type === 'request-error') failed = true
      if (frame.type === 'exit') exitCode = frame.code
      framePrinter(process.stdout, process.stderr)(frame)
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  if (failed || exitCode !== 0) process.exitCode = failed ? 1 : (exitCode ?? 1)
}

async function remoteCat(args: readonly string[]): Promise<void> {
  const { flags, positionals } = parseFlags(args)
  checkHelp(flags)
  const user = positionals[0]
  const path = positionals[1]
  if (user === undefined || path === undefined) {
    console.error('usage: dsh-shell remote cat [--control-port N] <user> <path>')
    process.exit(1)
  }
  let failed = false
  try {
    await runFsRead(controlPort(flags), { user, path }, (frame) => {
      if (frame.type === 'request-error') failed = true
      framePrinter(process.stdout, process.stderr)(frame)
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  if (failed) process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
