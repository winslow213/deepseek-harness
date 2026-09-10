/**
 * Control-side client for the remote hub loopback HTTP API.
 *
 * Used by the `dsh-shell remote` CLI subcommands today and by the future dsh
 * remote-executor plugin later; the executor can call these same functions
 * with `fetch` from inside a per-user instance.
 *
 * @module dsh-team-shell/remote-client
 */

import type { AgentRecord, MountRecord } from './hub.ts'

export interface ExecSpec {
  user: string
  /** Disambiguates among several agents for one user; omit for a single agent. */
  agentId?: string
  argv: readonly string[]
  cwd?: string
  timeoutMs?: number
}

export interface FsReadSpec {
  user: string
  /** Disambiguates among several agents for one user; omit for a single agent. */
  agentId?: string
  path: string
  maxBytes?: number
}

/** One NDJSON frame from a hub stream response. */
export type ResultFrame =
  | { type: 'stream'; channel: 'stdout' | 'stderr' | 'data'; data: string }
  | { type: 'exit'; code: number | null; signal: string | null }
  | { type: 'request-error'; message: string }

/** Normalize a hub control base URL (trailing slash removed, validated). */
export function hubControlBase(hubBase: string): string {
  const base = hubBase.replace(/\/+$/, '')
  if (!/^https?:\/\/./.test(base)) throw new Error(`invalid hub base URL: ${JSON.stringify(hubBase)}`)
  return base
}

/** The loopback control base for a port (CLI default). */
export function loopbackControlBase(controlPort: number): string {
  return hubControlBase(`http://127.0.0.1:${String(controlPort)}`)
}

/** List connected agents (GET /api/agents). */
export async function listAgents(hubBase: string): Promise<AgentRecord[]> {
  const res = await fetch(`${hubControlBase(hubBase)}/api/agents`)
  if (!res.ok) throw new Error(`hub returned ${String(res.status)}: ${await res.text()}`)
  return (await res.json()) as AgentRecord[]
}

/** List mountable regions (GET /api/mounts). */
export async function listMounts(hubBase: string): Promise<MountRecord[]> {
  const res = await fetch(`${hubControlBase(hubBase)}/api/mounts`)
  if (!res.ok) throw new Error(`hub returned ${String(res.status)}: ${await res.text()}`)
  return (await res.json()) as MountRecord[]
}

/** Parse an NDJSON body into frames; rejects on HTTP errors. */
export async function readFrames(res: Response, onFrame: (frame: ResultFrame) => void): Promise<void> {
  if (!res.ok) {
    throw new Error(`hub returned ${String(res.status)}: ${await res.text()}`)
  }
  const body = res.body
  if (body === null) throw new Error('hub response has no body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl)
      pending = pending.slice(nl + 1)
      if (line.length === 0) continue
      onFrame(JSON.parse(line) as ResultFrame)
    }
  }
}

/** Run an `exec` request; `onFrame` receives every NDJSON frame. */
export async function runExec(hubBase: string, spec: ExecSpec, onFrame: (frame: ResultFrame) => void): Promise<void> {
  const res = await fetch(`${hubControlBase(hubBase)}/api/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: spec.user,
      ...spec.agentId === undefined ? {} : { agentId: spec.agentId },
      argv: spec.argv,
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
    }),
  })
  await readFrames(res, onFrame)
}

/** Ask the agent to kill an in-flight exec by request id (fire-and-forget). */
export async function runKill(hubBase: string, user: string, id: string, agentId?: string): Promise<void> {
  const res = await fetch(`${hubControlBase(hubBase)}/api/kill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, id, ...agentId === undefined ? {} : { agentId } }),
  })
  if (!res.ok) throw new Error(`hub returned ${String(res.status)}: ${await res.text()}`)
}

/** Stream a file via the agent's `fs:read` primitive (the `cat` probe). */
export async function runFsRead(hubBase: string, spec: FsReadSpec, onFrame: (frame: ResultFrame) => void): Promise<void> {
  const res = await fetch(`${hubControlBase(hubBase)}/api/fs-read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: spec.user, ...spec.agentId === undefined ? {} : { agentId: spec.agentId }, path: spec.path, maxBytes: spec.maxBytes }),
  })
  await readFrames(res, onFrame)
}

/** Mint a one-time pairing code for a user (proves the user's agent secret). */
export async function createPairing(hubBase: string, user: string, secret: string): Promise<{
  uuid: string
  user: string
  expiresAt: number
  ttlMs: number
}> {
  const res = await fetch(`${hubControlBase(hubBase)}/api/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, secret }),
  })
  if (!res.ok) throw new Error(`hub returned ${String(res.status)}: ${await res.text()}`)
  return (await res.json()) as { uuid: string; user: string; expiresAt: number; ttlMs: number }
}

/** A single-value request to the hub fs-primitive API (`/api/fs`). */
export interface FsOpSpec {
  op: 'resolve' | 'stat' | 'lstat' | 'list' | 'readText' | 'readBytes' | 'readByteRange' | 'write' | 'edit'
  path?: string
  maxBytes?: number
  offset?: number
  length?: number
  content?: string
  expected?: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: string }
  oldString?: string
  newString?: string
  replaceAll?: boolean
}

/** Structured failure surfaced from the agent fs primitives. */
export class HubFsError extends Error {
  readonly code: string | undefined
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'HubFsError'
    this.code = code
  }
}

/**
 * Issue one fs primitive to a user's agent and resolve with its result value.
 * The hub relays `request-error` frames as {@link HubFsError} carrying the
 * agent's structured `FS_*` code.
 */
export async function fsOp(hubBase: string, user: string, spec: FsOpSpec, agentId?: string): Promise<unknown> {
  const res = await fetch(`${hubControlBase(hubBase)}/api/fs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, ...agentId === undefined ? {} : { agentId }, ...spec }),
  })
  if (!res.ok) {
    let detail: string
    try { detail = await res.text() } catch { detail = String(res.status) }
    throw new Error(`hub returned ${String(res.status)}: ${detail}`)
  }
  const reader = res.body?.getReader()
  if (reader === undefined) throw new Error('hub fs response has no body')
  const decoder = new TextDecoder()
  let pending = ''
  let value: unknown
  for (;;) {
    const { done, value: chunk } = await reader.read()
    if (done) break
    pending += decoder.decode(chunk, { stream: true })
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl)
      pending = pending.slice(nl + 1)
      if (line.length === 0) continue
      const frame = JSON.parse(line) as {
        type?: string; value?: unknown; message?: string; code?: string
      }
      if (frame.type === 'fs:result') {
        value = frame.value
      } else if (frame.type === 'request-error') {
        throw new HubFsError(frame.message ?? 'fs request failed', frame.code)
      }
    }
  }
  return value
}
