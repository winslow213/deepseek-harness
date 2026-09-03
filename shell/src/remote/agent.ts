/**
 * remote-agent daemon: runs on each user's own Linux host and dials the team
 * hub (direction B), so machines behind NAT never need an inbound port.
 *
 * The agent enforces its own allowlists — the last line of defence even if a
 * hub or a per-user dsh instance is compromised (design.md §7.4). It serves
 * two primitives:
 *   - `exec`      spawn argv[0] (an allowlisted basename) in a process group;
 *   - `fs:read`   stream a file that resolves under an allowlisted root.
 *
 * The daemon reconnects with exponential backoff after every dropped channel.
 *
 * @module dsh-team-shell/remote-agent
 *
 * @example
 * node shell/src/remote/agent.ts \
 *   --user alice --hub 10.33.2.56:7101 --token "$TOKEN" \
 *   --root /home/alice/code --allow-command cat --allow-command git
 */

import { connect, type Socket } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream, promises as fsp } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { hostname } from 'node:os'
import { pathToFileURL } from 'node:url'
import {
  makeLineReader,
  sendFrame,
  type AgentOutFrame,
  type ExecRequest,
  type FsReadRequest,
  type KillRequest,
} from './protocol.ts'

export interface AgentOptions {
  readonly user: string
  /** One-time pairing code; when present the agent omits user/token in hello. */
  readonly pairUuid: string
  readonly agentId: string
  readonly hubHost: string
  readonly hubPort: number
  readonly token: string
  readonly roots: readonly string[]
  readonly allowCommands: readonly string[]
  readonly reconnectCapMs: number
}

function usage(): never {
  console.error(
    [
      'usage: remote-agent (--user <user> --token <secret> | --pair <code>) --hub <host:port>',
      '       [--name <agent-id>] [--root <dir>]... [--allow-command <cmd>]...',
      '',
      '  --pair             one-time pairing code minted on the hub page/API; the',
      '                     hub binds this agent to the code\'s user (no --user/--token)',
      '  --user             user id this agent represents (must match a hub token)',
      '  --token            secret the hub issued for this user',
      '  --hub              hub host:port the agent dials (outbound only)',
      '  --name             agent id; defaults to <user>@<hostname> (pairing: pairing@<hostname>)',
      '  --root             real directory the agent may serve; repeatable, required',
      '  --allow-command    command basename exec may run; repeatable (empty = deny all exec)',
    ].join('\n'),
  )
  process.exit(2)
}

export function parseArgs(argv: readonly string[]): AgentOptions {
  const opts: { [k: string]: string | string[] } = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined || !arg.startsWith('--')) {
      console.error(`unexpected argument ${JSON.stringify(arg)}`)
      usage()
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      console.error(`missing value for ${arg}`)
      usage()
    }
    i += 1
    // `--allow-command` -> `allowCommand`; single-word flags are unchanged.
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    const existing = opts[key]
    if (existing === undefined) {
      opts[key] = value
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      opts[key] = [existing, value]
    }
  }
  const user = typeof opts.user === 'string' ? opts.user : ''
  const token = typeof opts.token === 'string' ? opts.token : ''
  const pairUuid = typeof opts.pair === 'string' ? opts.pair : ''
  const hub = typeof opts.hub === 'string' ? opts.hub : ''
  const hubSplit = hub.split(':')
  const hubPort = Number(hubSplit[hubSplit.length - 1])
  const hubHost = hubSplit.length > 1 ? hubSplit.slice(0, -1).join(':') : ''
  const roots = (Array.isArray(opts.root) ? opts.root : opts.root === undefined ? [] : [opts.root]) as string[]
  const allowCommands = (Array.isArray(opts.allowCommand)
    ? opts.allowCommand
    : opts.allowCommand === undefined ? [] : [opts.allowCommand]) as string[]
  const name = typeof opts.name === 'string' ? opts.name : ''
  const pairing = pairUuid !== ''
  const valid = pairing
    ? hubHost !== '' && !Number.isNaN(hubPort) && roots.length > 0
    : user !== '' && token !== '' && hubHost !== '' && !Number.isNaN(hubPort) && roots.length > 0
  if (!valid) usage()
  return {
    user,
    pairUuid,
    agentId: name === '' ? `${pairing ? 'pairing' : user}@${hostname()}` : name,
    hubHost,
    hubPort,
    token,
    roots,
    allowCommands,
    reconnectCapMs: 30_000,
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Agent state for one connected session. */
interface Session {
  readonly socket: Socket
  readonly opts: AgentOptions
  readonly realRoots: string[]
  readonly commands: ReadonlySet<string>
  /** In-flight exec children keyed by request id (kill targets). */
  readonly active: Map<string, ChildProcess>
  authed: boolean
}

/** SIGKILL a detached process group, ignoring an already-gone process. */
function killProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

/** True when `absPath` equals or lives under one of the real roots. */
function isUnderRoots(absPath: string, realRoots: readonly string[]): boolean {
  return realRoots.some((root) => absPath === root || absPath.startsWith(root + sep))
}

/**
 * Resolve `absPath` to a real path by resolving its deepest existing ancestor,
 * then reject it when the result is not under an allowlisted root. Missing
 * trailing components are re-appended to the real ancestor.
 */
async function resolveUnderRoot(absPath: string, realRoots: readonly string[]): Promise<string> {
  if (!isAbsolute(absPath)) {
    throw new Error(`path must be absolute: ${absPath}`)
  }
  const cleaned = normalize(absPath)
  const missing: string[] = []
  let probe = cleaned
  for (;;) {
    try {
      const real = await fsp.realpath(probe)
      const resolved = join(real, ...missing.reverse())
      if (!isUnderRoots(resolved, realRoots)) {
        throw new Error(`path outside allowed roots: ${absPath}`)
      }
      return resolved
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('path outside allowed roots')) throw error
      // Not an existing path yet; climb toward a parent that exists.
    }
    const parent = dirname(probe)
    if (parent === probe) {
      throw new Error(`no existing ancestor for ${absPath}`)
    }
    missing.push(basename(probe))
    probe = parent
  }
}

/**
 * Reject exec path arguments that could escape the allowlisted roots.
 *
 * Command-level allowlists alone are leaky (`head /etc/hostname`). This
 * token-level guard blocks any argument that resolves to an absolute location
 * outside the roots or climbs out with `..`; plain relative names stay under
 * cwd, which the caller already pinned inside a root. Symlinked escapes
 * inside a root are closed by the realpath-aware fs:read primitive, which is
 * the file access path the dsh fs tools use.
 */
function findUnsafePathArg(cwdReal: string, tokens: readonly string[], realRoots: readonly string[]): string | undefined {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined || token === '-') continue
    // A shell `-c` body is the command itself (arbitrary script text), not a
    // path argument. The agent's command allowlist is the gate for shells:
    // allowlisting `bash` deliberately grants arbitrary remote execution.
    if (token === '-c') {
      i += 1
      continue
    }
    const looksLikePath = token === '..' || token === '.' || token.includes('/') || token.includes('\\') || isAbsolute(token)
    if (!looksLikePath) continue
    const candidate = normalize(isAbsolute(token) ? token : join(cwdReal, token))
    if (!isUnderRoots(candidate, realRoots)) return token
  }
  return undefined
}

/** Run one `exec` request on the agent host and stream its output. */
async function runExec(session: Session, req: ExecRequest): Promise<void> {
  const send = (frame: AgentOutFrame) => { sendFrame(session.socket, frame) }
  const fail = (message: string) => { send({ type: 'request-error', id: req.id, message }) }
  const bin = req.argv[0] === undefined ? '' : basename(req.argv[0])
  if (!session.commands.has(bin)) {
    fail(`command not allowed: ${bin || '(empty)'}`)
    return
  }
  if (req.argv.length === 0) {
    fail('empty argv')
    return
  }
  let cwd = req.cwd ?? session.realRoots[0]
  if (cwd === undefined) {
    fail('no root to serve as cwd')
    return
  }
  try {
    const realCwd = await fsp.realpath(cwd)
    if (!isUnderRoots(realCwd, session.realRoots)) {
      fail(`cwd outside allowed roots: ${cwd}`)
      return
    }
    cwd = realCwd
  } catch {
    fail(`cwd does not exist: ${cwd}`)
    return
  }
  const unsafe = findUnsafePathArg(cwd, req.argv.slice(1), session.realRoots)
  if (unsafe !== undefined) {
    fail(`path outside allowed roots: ${unsafe}`)
    return
  }

  const child = spawn(req.argv[0]!, req.argv.slice(1), {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  session.active.set(req.id, child)
  const timer = req.timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      killProcessGroup(child)
    }, req.timeoutMs)
  child.stdout?.on('data', (data: Buffer) => {
    send({ type: 'stream', id: req.id, channel: 'stdout', data: data.toString('utf8') })
  })
  child.stderr?.on('data', (data: Buffer) => {
    send({ type: 'stream', id: req.id, channel: 'stderr', data: data.toString('utf8') })
  })
  child.on('error', (error: Error) => { fail(`spawn failed: ${error.message}`) })
  child.on('close', (code, signal) => {
    session.active.delete(req.id)
    if (timer !== undefined) clearTimeout(timer)
    send({ type: 'exit', id: req.id, code, signal })
  })
}

/** Kill one in-flight exec's process group (no-op when the id is unknown). */
function killExec(session: Session, req: KillRequest): void {
  const child = session.active.get(req.id)
  if (child === undefined) return
  killProcessGroup(child)
}

/** Stream the content of a file under an allowed root (the `cat` primitive). */
async function runFsRead(session: Session, req: FsReadRequest): Promise<void> {
  const send = (frame: AgentOutFrame) => { sendFrame(session.socket, frame) }
  const fail = (message: string) => { send({ type: 'request-error', id: req.id, message }) }
  let target: string
  try {
    target = await resolveUnderRoot(req.path, session.realRoots)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return
  }
  const maxBytes = req.maxBytes ?? 4 * 1024 * 1024
  let sent = 0
  const stream = createReadStream(target, { highWaterMark: 64 * 1024 })
  stream.on('data', (chunk: string | Buffer) => {
    sent += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
    if (sent > maxBytes) {
      stream.destroy()
      fail(`file exceeds ${maxBytes} bytes`)
      return
    }
    send({ type: 'stream', id: req.id, channel: 'data', data: typeof chunk === 'string' ? chunk : chunk.toString('utf8') })
  })
  stream.on('error', (error: Error) => { fail(`read failed: ${error.message}`) })
  stream.on('end', () => { send({ type: 'exit', id: req.id, code: 0, signal: null }) })
}

/** Dispatch one hub frame to the matching handler. */
function handleFrame(session: Session, frame: unknown): void {
  const send = (out: AgentOutFrame) => { sendFrame(session.socket, out) }
  if (frame === null || typeof frame !== 'object') return
  const msg = frame as { type?: string }
  switch (msg.type) {
    case 'hello_ack':
      session.authed = true
      console.error(`[agent] authenticated as ${session.opts.agentId}`)
      break
    case 'error':
      console.error(`[agent] hub error: ${String((frame as { message?: string }).message)}`)
      session.socket.destroy()
      break
    case 'ping':
      send({ type: 'pong' })
      break
    case 'exec':
      void runExec(session, frame as ExecRequest)
      break
    case 'kill':
      killExec(session, frame as KillRequest)
      break
    case 'fs:read':
      void runFsRead(session, frame as FsReadRequest)
      break
    default:
      break
  }
}

/** Connect once, run until the channel drops; resolves on close. */
function connectOnce(opts: AgentOptions, realRoots: string[], commands: ReadonlySet<string>): Promise<void> {
  return new Promise((done) => {
    const socket = connect({ host: opts.hubHost, port: opts.hubPort })
    const session: Session = { socket, opts, realRoots, commands, active: new Map(), authed: false }
    const send = (out: AgentOutFrame) => { sendFrame(socket, out) }

    socket.on('connect', () => {
      console.error(`[agent] dialed ${opts.hubHost}:${String(opts.hubPort)}`)
      send({
        type: 'hello',
        agentId: opts.agentId,
        ...opts.pairUuid !== ''
          ? { pairUuid: opts.pairUuid }
          : { user: opts.user, token: opts.token },
        roots: realRoots,
        commands: [...commands],
      })
    })
    const reader = makeLineReader(
      (frame) => handleFrame(session, frame),
      (message) => {
        console.error(`[agent] protocol violation: ${message}`)
        socket.destroy()
      },
    )
    socket.on('data', reader)
    socket.on('error', (error: Error) => {
      console.error(`[agent] channel error: ${error.message}`)
    })
    socket.on('close', () => done())
  })
}

async function connectLoop(opts: AgentOptions): Promise<void> {
  const realRoots = await Promise.all(
    opts.roots.map(async (root) => {
      const real = await fsp.realpath(root)
      console.error(`[agent] serving root ${real}`)
      return real
    }),
  )
  const commands = new Set(opts.allowCommands)
  if (commands.size === 0) {
    console.error('[agent] warning: no --allow-command given; exec requests will all be denied')
  }

  let running = true
  const stop = () => {
    running = false
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  let attempt = 0
  while (running) {
    await connectOnce(opts, realRoots, commands)
    if (!running) break
    const delay = Math.min(1000 * 2 ** attempt, opts.reconnectCapMs)
    attempt += 1
    console.error(`[agent] disconnected; reconnecting in ${String(delay)} ms`)
    await sleep(delay)
  }
}

// Entry so the file doubles as `node shell/src/remote/agent.ts`.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void startAgent(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`[agent] fatal: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}

/** Parse agent CLI flags and run the daemon until the process is stopped. */
export async function startAgent(args: readonly string[]): Promise<void> {
  await connectLoop(parseArgs([...args]))
}
