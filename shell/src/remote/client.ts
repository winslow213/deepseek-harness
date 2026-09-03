/**
 * Control-side client for the remote hub loopback HTTP API.
 *
 * Used by the `dsh-shell remote` CLI subcommands today and by the future dsh
 * remote-executor plugin later; the executor can call these same functions
 * with `fetch` from inside a per-user instance.
 *
 * @module dsh-team-shell/remote-client
 */

import type { AgentRecord } from './hub.ts'

export interface ExecSpec {
  user: string
  argv: readonly string[]
  cwd?: string
  timeoutMs?: number
}

export interface FsReadSpec {
  user: string
  path: string
  maxBytes?: number
}

/** One NDJSON frame from a hub stream response. */
export type ResultFrame =
  | { type: 'stream'; channel: 'stdout' | 'stderr' | 'data'; data: string }
  | { type: 'exit'; code: number | null; signal: string | null }
  | { type: 'request-error'; message: string }

function controlBase(controlPort: number): string {
  return `http://127.0.0.1:${String(controlPort)}`
}

/** List connected agents (GET /api/agents). */
export async function listAgents(controlPort: number): Promise<AgentRecord[]> {
  const res = await fetch(`${controlBase(controlPort)}/api/agents`)
  if (!res.ok) throw new Error(`hub returned ${String(res.status)}: ${await res.text()}`)
  return (await res.json()) as AgentRecord[]
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
export async function runExec(controlPort: number, spec: ExecSpec, onFrame: (frame: ResultFrame) => void): Promise<void> {
  const res = await fetch(`${controlBase(controlPort)}/api/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: spec.user, argv: spec.argv, cwd: spec.cwd, timeoutMs: spec.timeoutMs }),
  })
  await readFrames(res, onFrame)
}

/** Stream a file via the agent's `fs:read` primitive (the `cat` probe). */
export async function runFsRead(controlPort: number, spec: FsReadSpec, onFrame: (frame: ResultFrame) => void): Promise<void> {
  const res = await fetch(`${controlBase(controlPort)}/api/fs-read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: spec.user, path: spec.path, maxBytes: spec.maxBytes }),
  })
  await readFrames(res, onFrame)
}
