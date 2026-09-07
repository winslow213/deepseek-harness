/**
 * Environment self-check for the remote-agent CLI.
 *
 * Diagnoses the common failure modes a member hits before a successful mount:
 * an unsupported Node, an unreachable hub, an expired pairing code, a missing
 * or unreadable `--root`, and command names not present on this host. Each
 * check prints a PASS/FAIL line with the reason; a FAIL exits non-zero so a
 * batch/script can key off it. The pairing-code probe is a real hello
 * handshake, so it also proves the hub's claim path and this machine's
 * outbound route in one step.
 *
 * @module dsh-team-shell/remote-check
 */

import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { hostname } from 'node:os'
import { makeLineReader, sendFrame } from './protocol.ts'

/** Minimum Node major/minor the harness supports (see root package.json engines). */
const MIN_NODE = { major: 22, minor: 19 } as const

/** Seconds a hub TCP connect may wait before being declared unreachable. */
const CONNECT_TIMEOUT_MS = 5000

/** Seconds a pairing hello handshake may wait for the hub's answer. */
const PAIRING_TIMEOUT_MS = 5000

interface CheckItem {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

/** Parsed self-check invocation (all fields optional except the mode flag). */
export interface CheckOptions {
  hub?: string
  pair?: string
  roots: string[]
  allowCommands: string[]
}

function fail(): never {
  console.error('usage: dsh-mount-agent --check [--hub host:port] [--pair code] [--root dir]... [--allow-command cmd]...')
  process.exit(2)
}

/** Parse the loose `--check` form: every field is optional, `--root`/`--allow-command` repeatable. */
export function parseCheckArgs(argv: readonly string[]): CheckOptions {
  const opts: { [k: string]: string | string[] } = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined || !arg.startsWith('--')) fail()
    if (arg === '--check') continue
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) fail()
    i += 1
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    const existing = opts[key]
    if (existing === undefined) opts[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else opts[key] = [existing, value]
  }
  return {
    hub: typeof opts.hub === 'string' ? opts.hub : undefined,
    pair: typeof opts.pair === 'string' ? opts.pair : undefined,
    roots: (Array.isArray(opts.root) ? opts.root : opts.root === undefined ? [] : [opts.root]) as string[],
    allowCommands: (Array.isArray(opts.allowCommand)
      ? opts.allowCommand
      : opts.allowCommand === undefined ? [] : [opts.allowCommand]) as string[],
  }
}

/** Parse a Node version string into { major, minor }. */
function nodeVersion(): { major: number; minor: number } {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return { major: major ?? 0, minor: minor ?? 0 }
}

/** Whether this Node satisfies the engines range `^22.19 || >=24`. */
function nodeSupported(): boolean {
  const { major, minor } = nodeVersion()
  return (major === 22 && minor >= 19) || major >= 24
}

/** Resolve `host:port`, tolerating an IPv6 host (bracketed) and a bare port. */
function splitHub(hub: string): { host: string; port: number } | undefined {
  const parts = hub.split(':')
  const port = Number(parts[parts.length - 1])
  if (Number.isNaN(port) || port <= 0 || port > 65535) return undefined
  const host = parts.length > 1 ? parts.slice(0, -1).join(':').replace(/^\[|\]$/g, '') : ''
  return host === '' ? undefined : { host, port }
}

/** Open a TCP connection to the hub within a timeout, closing it immediately. */
function canReachHub(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), CONNECT_TIMEOUT_MS)
    socket.once('connect', () => { clearTimeout(timer); done(true) })
    socket.once('error', () => { clearTimeout(timer); done(false) })
    socket.once('close', () => { clearTimeout(timer) })
  })
}

/**
 * Prove a pairing code over a real hello handshake: dial the hub, send a hello
 * with the code, and read until `hello_ack` (valid) or `error`/close (invalid).
 * An empty roots/commands list is accepted for the probe — the hub only
 * requires `agentId` and a `roots` array.
 */
function verifyPairing(host: string, port: number, pair: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const settle = (ok: boolean, detail: string): void => {
      socket.destroy()
      resolve({ ok, detail })
    }
    const timer = setTimeout(() => settle(false, `no hub answer within ${PAIRING_TIMEOUT_MS / 1000}s`), PAIRING_TIMEOUT_MS)
    socket.once('connect', () => {
      sendFrame(socket, { type: 'hello', agentId: `check@${hostname()}`, pairUuid: pair, roots: [], commands: [] })
    })
    socket.once('error', () => { clearTimeout(timer); settle(false, 'connection failed') })
    socket.once('close', () => { clearTimeout(timer); settle(false, 'hub closed the connection') })
    socket.on('data', makeLineReader((frame) => {
      const f = frame as { type?: string; user?: string; message?: string }
      if (f.type === 'hello_ack') {
        clearTimeout(timer)
        settle(true, `code valid, bound to user "${String(f.user)}"`)
      } else if (f.type === 'error') {
        clearTimeout(timer)
        settle(false, String(f.message ?? 'hub rejected the code'))
      }
    }))
  })
}

/** Check that a directory exists and is readable (stat + readdir). */
async function checkRoot(root: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const stat = await fsp.stat(root)
    if (!stat.isDirectory()) return { ok: false, detail: 'not a directory' }
    await fsp.readdir(root)
    return { ok: true, detail: 'exists and is readable' }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/** Check a command basename is discoverable on this host (which/where). */
function checkCommand(command: string): { ok: boolean; detail: string } {
  const isWin = process.platform === 'win32'
  const probe = spawnSync(isWin ? 'where' : 'which', [command], { encoding: 'utf8' })
  if (probe.status === 0 && (probe.stdout ?? '').trim() !== '') {
    return { ok: true, detail: `${(probe.stdout ?? '').trim().split(/\r?\n/)[0] ?? ''}` }
  }
  return { ok: false, detail: `not found on PATH (${isWin ? 'where' : 'which'} ${command} failed)` }
}

/**
 * Run the self-check and print a PASS/FAIL report, exiting 0 when every check
 * passed and 1 otherwise. All checks are independent; a missing optional field
 * simply skips that check with a note.
 */
export async function checkEnvironment(opts: CheckOptions): Promise<number> {
  const items: CheckItem[] = []

  const { major, minor } = nodeVersion()
  const nodeOk = nodeSupported()
  items.push({
    name: 'Node.js version',
    ok: nodeOk,
    detail: nodeOk
      ? `${process.version} (supported)`
      : `${process.version} (unsupported; needs ${MIN_NODE.major}.${MIN_NODE.minor} or >=24)`,
  })
  items.push({
    name: 'Operating system',
    ok: true,
    detail: `${process.platform} ${process.arch}`,
  })

  if (opts.hub !== undefined) {
    const target = splitHub(opts.hub)
    if (target === undefined) {
      items.push({ name: 'Hub address', ok: false, detail: `cannot parse host:port from ${JSON.stringify(opts.hub)}` })
    } else {
      const reachable = await canReachHub(target.host, target.port)
      items.push({
        name: 'Hub reachability',
        ok: reachable,
        detail: reachable
          ? `${target.host}:${target.port} reachable`
          : `${target.host}:${target.port} unreachable (check the host and that the hub is running)`,
      })
      if (reachable && opts.pair !== undefined) {
        const pair = await verifyPairing(target.host, target.port, opts.pair)
        items.push({ name: 'Pairing code', ok: pair.ok, detail: pair.detail })
      }
    }
  } else if (opts.pair !== undefined) {
    items.push({ name: 'Pairing code', ok: false, detail: '--pair given but --hub missing; cannot verify' })
  }

  for (const root of opts.roots) {
    const result = await checkRoot(root)
    items.push({ name: `Root directory ${root}`, ok: result.ok, detail: result.detail })
  }
  if (opts.roots.length === 0) {
    items.push({ name: 'Root directory', ok: false, detail: 'no --root given; a mount needs at least one served directory' })
  }

  for (const command of opts.allowCommands) {
    const result = checkCommand(command)
    items.push({ name: `Command ${command}`, ok: result.ok, detail: result.detail })
  }

  // Report.
  console.log('dsh-mount-agent environment check')
  console.log('--------------------------------')
  let allOk = true
  for (const item of items) {
    if (!item.ok) allOk = false
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}: ${item.detail}`)
  }
  console.log('--------------------------------')
  console.log(allOk ? 'All checks passed.' : 'Some checks failed; fix the FAIL lines above and re-run.')
  return allOk ? 0 : 1
}
