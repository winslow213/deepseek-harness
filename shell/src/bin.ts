/**
 * dsh Team Shell CLI entry.
 * @module dsh-team-shell/bin
 */

import { readFileSync } from 'node:fs'
import { registerOnReady, spawnUserInstance, superviseUserInstance, userHome } from './spawn-user.ts'
import { startProxy, startAccountProxy } from './reverse-proxy.ts'
import { join } from 'node:path'
import { createHub, type ConsumedPairing, type TeamHub } from './remote/hub.ts'
import { startAgent } from './remote/agent.ts'
import { listAgents, listMounts, loopbackControlBase, runExec, runFsRead, createPairing, type ResultFrame } from './remote/client.ts'
import { injectRemoteProviders, PROFILE_PATCH_FILENAME } from './remote/inject.ts'
import { accountBaseUrl, adminSecret, unregisterInstance } from './instance-register.ts'

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
      // Supervision is the default: the child inherits DSH_SUPERVISED=1 so an
      // in-process install can write the restart marker and exit; the loop
      // relaunches a fresh generation. Pass `--once` to keep the old one-shot
      // behavior (no auto-restart on a marker).
      const once = args.includes('--once')
      const supervised = !once
      if (supervised) process.env.DSH_SUPERVISED = '1'
      const instance = supervised ? superviseUserInstance(user, port) : spawnUserInstance(user, port)
      const account = accountBaseUrl()
      const secret = adminSecret()
      // A supervised spawn registers itself (every generation, with the launch
      // token) inside the supervision loop; a one-shot spawn registers here.
      if (account !== undefined && !supervised) {
        void registerOnReady(user, port, instance)
      }
      instance.url.then((url) => {
        console.log(`USER URL: ${url}`)
      }).catch((error: unknown) => {
        console.error(`spawn failed: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      })
      // The account service stops the supervisor with SIGTERM; SIGINT is the
      // interactive Ctrl-C path. Both must stop the child and unregister so no
      // dsh web instance is orphaned on a different port than its record.
      const shutdown = async (): Promise<void> => {
        await instance.stop()
        if (account !== undefined) await unregisterInstance(account, user, secret)
        process.exit(0)
      }
      process.on('SIGINT', () => { void shutdown() })
      process.on('SIGTERM', () => { void shutdown() })
      break
    }
    case 'proxy': {
      // Account mode: dsh-shell proxy <entryPort> --account <accountUrl>
      // Static mode: dsh-shell proxy <entryPort> <userA:portA> [userB:portB ...]
      const entryPort = Number(args[0])
      const accountIndex = args.indexOf('--account')
      if (!Number.isNaN(entryPort) && accountIndex >= 0) {
        const accountUrl = args[accountIndex + 1]
        if (accountUrl === undefined || accountUrl === '') {
          console.error('usage: dsh-shell proxy <entryPort> --account <accountUrl>')
          process.exit(1)
        }
        const server = startAccountProxy({ port: entryPort, accountUrl })
        console.log(`account proxy listening on http://0.0.0.0:${String(entryPort)} (account ${accountUrl})`)
        process.on('SIGINT', () => { server.close(() => process.exit(0)) })
        break
      }
      const upstreams = accountIndex >= 0 ? args.slice(1, accountIndex) : args.slice(1)
      if (Number.isNaN(entryPort) || upstreams.length === 0) {
        console.error('usage: dsh-shell proxy <entryPort> <user:port> [user:port ...]')
        console.error('       dsh-shell proxy <entryPort> --account <accountUrl>')
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
        case 'mounts':
          await remoteMounts(rest)
          break
        case 'exec':
          await remoteExec(rest)
          break
        case 'cat':
          await remoteCat(rest)
          break
        case 'pair':
          await remotePair(rest)
          break
        case 'inject':
          await remoteInject(rest)
          break
        default:
          console.error(
            [
              'usage: dsh-shell remote <hub|agent|agents|mounts|exec|cat|pair|inject> ...',
              '  hub      start the hub  (see remote hub --help)',
              '  agent    start an agent  (see remote agent --help)',
              '  agents   list connected agents',
              '  mounts   list mountable agent roots under /dsh-mount',
              '  exec     run a command through a user\'s agent',
              '  cat      stream a file through a user\'s agent',
              '  pair     mint a one-time pairing code for a user (and optionally wait)',
              '  inject   point a per-user profile\'s shell at the remote executor',
            ].join('\n'),
          )
          process.exit(1)
      }
      break
    }
    case 'account': {
      const { main: accountMain } = await import('./account/server.ts')
      await accountMain()
      break
    }
    case 'account-cli': {
      const { main: accountCli } = await import('./account/cli.ts')
      await accountCli(args)
      break
    }
    default:
      console.error('usage: dsh-shell <spawn-user|proxy|remote|account|account-cli> ...')
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
    console.error(
      'usage: dsh-shell remote hub --user-token user=secret[,...] [--account URL] [--account-secret SECRET] [--agent-port N] [--control-port N] [--shadow-root DIR] [--no-auto-inject]',
    )
    process.exit(0)
  }
  if (positionals.length > 0) {
    console.error(`unexpected positional ${positionals[0]}`)
    process.exit(1)
  }
  const agentPort = intFlag(flags, 'agent-port', 'DSH_HUB_AGENT_PORT', 7101)
  const control = controlPort(flags)
  const shadowRoot = flags.get('shadow-root')
  const autoInject = flags.get('no-auto-inject') !== 'true'
  const accountUrl = flags.get('account') ?? process.env.TEAM_ACCOUNT_URL
  const accountSecret = flags.get('account-secret') ?? process.env.TEAM_ADMIN_SECRET
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
  if (tokens.size === 0 && (accountUrl === undefined || accountUrl === '')) {
    console.error('usage: dsh-shell remote hub --user-token user=secret[,...] [--account URL] [--account-secret SECRET]')
    process.exit(1)
  }

  const onPaired = autoInject
    ? (pairing: ConsumedPairing): void => {
      // On a completed pairing, provision the user's profile with the remote
      // executor. The injected cwd defaults to the agent's first served root.
      // An existing non-generated patch file is left untouched (loud, not silent).
      try {
        const profileDir = join(userHome(pairing.user), 'profiles', 'web')
        const patch = join(profileDir, PROFILE_PATCH_FILENAME)
        let isOurs = false
        let exists = false
        try {
          const text = readFileSync(patch, 'utf8')
          exists = true
          isOurs = text.includes('Injected by the team shell')
        } catch {
          exists = false
        }
        if (exists && !isOurs) {
          console.error(`[hub] not auto-injecting ${pairing.user}: ${patch} exists and is not a generated patch; edit it manually`)
          return
        }
        const runtimeSourceDir = new URL('./remote/', import.meta.url).pathname
        const cwd = pairing.agent.roots[0] ?? pairing.user
        const written = injectRemoteProviders({
          runtimeSourceDir,
          hubUrl: loopbackControlBase(control),
          user: pairing.user,
          shellCwd: cwd,
          fsCwd: cwd,
          profileDir,
          includeFs: true,
        })
        console.log(`[hub] auto-injected remote executor+fs for ${pairing.user} -> ${written} (root ${cwd})`)
      } catch (error) {
        console.error(`[hub] auto-inject failed for ${pairing.user}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    : undefined
  const hub = createHub({
    agentPort,
    controlPort: control,
    tokens,
    onPaired,
    ...shadowRoot === undefined ? {} : { shadowRoot },
    ...accountUrl === undefined || accountUrl === '' ? {} : { accountUrl },
    ...accountSecret === undefined || accountSecret === '' ? {} : { adminSecret: accountSecret },
  })
  console.log(`hub agent listener on 0.0.0.0:${String(agentPort)}`)
  console.log(`hub control API on http://127.0.0.1:${String(control)}`)
  console.log(autoInject ? 'auto-inject: on (paired agents get remote providers injected)' : 'auto-inject: off')
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
  const agents = await listAgents(loopbackControlBase(controlPort(flags)))
  console.log(JSON.stringify(agents, null, 2))
}

async function remoteMounts(args: readonly string[]): Promise<void> {
  const { flags, positionals } = parseFlags(args)
  checkHelp(flags)
  if (positionals.length > 0) {
    console.error(`unexpected positional ${positionals[0]}`)
    process.exit(1)
  }
  const mounts = await listMounts(loopbackControlBase(controlPort(flags)))
  console.log(JSON.stringify(mounts, null, 2))
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
    await runExec(loopbackControlBase(controlPort(flags)), { user, argv }, (frame) => {
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
    await runFsRead(loopbackControlBase(controlPort(flags)), { user, path }, (frame) => {
      if (frame.type === 'request-error') failed = true
      framePrinter(process.stdout, process.stderr)(frame)
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  if (failed) process.exitCode = 1
}

/** Mint a one-time pairing code; with --wait, poll until the user's agent registers. */
async function remotePair(args: readonly string[]): Promise<void> {
  const { flags, positionals } = parseFlags(args)
  checkHelp(flags)
  const user = flags.get('user')
  const secret = flags.get('secret')
  if (user === undefined || secret === undefined) {
    console.error('usage: dsh-shell remote pair --user <u> --secret <agent-token> [--control-port N] [--wait]')
    process.exit(1)
  }
  if (positionals.length > 0) {
    console.error(`unexpected positional ${positionals[0]}`)
    process.exit(1)
  }
  const base = loopbackControlBase(controlPort(flags))
  const pairing = await createPairing(base, user, secret)
  const ttlMin = Math.round(pairing.ttlMs / 60_000)
  console.log(`PAIRING UUID: ${pairing.uuid}`)
  console.log(`user=${pairing.user} ttl=${String(ttlMin)}min`)
  console.log(`on the target host run: dsh-shell remote agent --pair ${pairing.uuid} --hub <hub:${String(intFlag(flags, 'agent-port', 'DSH_HUB_AGENT_PORT', 7101))}> --root <dir> [--allow-command bash ...]`)
  if (flags.get('wait') === 'true') {
    const deadline = Date.now() + pairing.ttlMs
    process.stdout.write('waiting for agent...')
    for (;;) {
      if (Date.now() > deadline) {
        console.log('\nTIMEOUT: no agent claimed the pairing code before expiry')
        process.exit(1)
      }
      const agents = await listAgents(base)
      if (agents.some((a) => a.user === user)) {
        console.log(`\nagent online for ${user}`)
        break
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}

/** Point a per-user profile's shell (and fs) executor at the remote bridge. */
async function remoteInject(args: readonly string[]): Promise<void> {
  const { flags, positionals } = parseFlags(args)
  if (flags.get('help') === 'true') {
    console.error(
      'usage: dsh-shell remote inject --home <dsh-home> --hub <url> --user <u> --cwd <remote-dir> [--no-fs] [--sandbox-mode <mode>]',
    )
    process.exit(0)
  }
  const home = flags.get('home')
  const hub = flags.get('hub')
  const user = flags.get('user')
  const cwd = flags.get('cwd')
  if (home === undefined || hub === undefined || user === undefined || cwd === undefined) {
    console.error('remote inject requires --home <dsh-home> --hub <url> --user <u> --cwd <remote-dir>')
    process.exit(1)
  }
  if (positionals.length > 0) {
    console.error(`unexpected positional ${positionals[0]}`)
    process.exit(1)
  }
  const modeFlag = flags.get('sandbox-mode')
  const sandboxMode = modeFlag === undefined
    ? undefined
    : modeFlag === 'read-only' || modeFlag === 'workspace-write' || modeFlag === 'danger-full-access'
      ? modeFlag
      : (console.error(`invalid --sandbox-mode ${JSON.stringify(modeFlag)}; expected read-only|workspace-write|danger-full-access`), process.exit(1), undefined)
  const profileDir = join(home, 'profiles', 'web')
  const runtimeSourceDir = new URL('./remote/', import.meta.url).pathname
  const includeFs = flags.get('no-fs') !== 'true'
  const written = injectRemoteProviders({
    runtimeSourceDir,
    hubUrl: hub,
    user,
    shellCwd: cwd,
    fsCwd: cwd,
    profileDir,
    includeFs,
    sandboxMode,
  })
  console.log(`injected remote ${includeFs ? 'executor+fs' : 'executor'} for user ${user} into ${written}`)
  console.log(`runtime modules: ${join(profileDir, 'plugins', 'remote')}`)
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
