/**
 * Team hub for the remote execution bridge (direction B).
 *
 * Agents dial a persistent outbound TCP channel to the hub's agent listener;
 * per-user dsh instances (and CLI operators) reach the hub over a loopback
 * HTTP control API and stream responses back as NDJSON. The hub is only a
 * registry and a relay: enforcement of which commands and paths an agent
 * serves lives in the agent itself (design.md §7.4).
 *
 * @module dsh-team-shell/remote-hub
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createNetServer, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import {
  encodeFrame,
  makeLineReader,
  type HelloFrame,
  type PingFrame,
  type RequestFrame,
  type StreamFrame,
} from './protocol.ts'

export interface HubOptions {
  /** External listener where agents dial in. */
  agentPort: number
  agentHost?: string
  /** Loopback HTTP control API for dsh-side executors. */
  controlPort: number
  controlHost?: string
  /** Map of user id to the agent token issued for that user. */
  tokens: ReadonlyMap<string, string>
  /** Interval between hub heartbeat pings to each agent. */
  heartbeatMs?: number
}

/** Public view of a connected agent (no socket). */
export interface AgentRecord {
  agentId: string
  user: string
  remote: string
  roots: readonly string[]
  commands: readonly string[]
  connectedAt: number
  lastSeen: number
}

interface AgentConn extends AgentRecord {
  socket: Socket
}

interface PendingRequest {
  res: ServerResponse
  conn: AgentConn
}

export interface TeamHub {
  agentPort: number
  controlPort: number
  /** Snapshot of connected agents, newest first. */
  agents(): AgentRecord[]
  /** Stop both listeners and terminate every agent channel. */
  close(): Promise<void>
}

/** Serialize a frame to an NDJSON HTTP response, skipping already-closed sinks. */
function writeNdjson(res: ServerResponse, frame: unknown): void {
  if (res.destroyed || res.writableEnded) return
  res.write(`${JSON.stringify(frame)}\n`)
}

/** Collect a JSON request body, capped at 1 MiB. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
      if (raw.length > 1 << 20) {
        req.destroy()
        reject(new Error('request body exceeds 1 MiB'))
      }
    })
    req.on('end', () => {
      if (raw === '') {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/** Validate and authenticate an agent `hello`, registering it on success. */
function authenticate(
  byUser: Map<string, AgentConn>,
  byAgentId: Map<string, AgentConn>,
  tokens: ReadonlyMap<string, string>,
  socket: Socket,
  frame: unknown,
): AgentConn | null {
  const sendError = (message: string) => {
    if (!socket.destroyed) socket.write(encodeFrame({ type: 'error', message }))
  }
  if (frame === null || typeof frame !== 'object') {
    sendError('malformed hello')
    socket.destroy()
    return null
  }
  const hello = frame as Partial<HelloFrame>
  if (hello.type !== 'hello' || typeof hello.user !== 'string' || typeof hello.agentId !== 'string' || typeof hello.token !== 'string') {
    sendError('malformed hello')
    socket.destroy()
    return null
  }
  const expected = tokens.get(hello.user)
  if (expected === undefined || expected !== hello.token) {
    sendError('authentication failed')
    socket.destroy()
    return null
  }

  const conn: AgentConn = {
    agentId: hello.agentId,
    user: hello.user,
    remote: `${socket.remoteAddress ?? '?'}:${String(socket.remotePort ?? '?')}`,
    roots: hello.roots ?? [],
    commands: hello.commands ?? [],
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    socket,
  }
  // A newer connection replaces an older one for the same user or agent id.
  byUser.get(conn.user)?.socket.destroy()
  byAgentId.get(conn.agentId)?.socket.destroy()
  byUser.set(conn.user, conn)
  byAgentId.set(conn.agentId, conn)
  if (!socket.destroyed) {
    socket.write(encodeFrame({ type: 'hello_ack', agentId: conn.agentId, user: conn.user }))
  }
  return conn
}

/** Relay one agent frame to its pending HTTP response (stream frames only). */
function relayStream(pending: Map<string, PendingRequest>, conn: AgentConn, frame: StreamFrame): void {
  const p = pending.get(frame.id)
  if (p !== undefined && p.conn === conn) writeNdjson(p.res, frame)
}

/** End one pending HTTP response with an exit/error frame. */
function endPending(pending: Map<string, PendingRequest>, conn: AgentConn, frame: { id: string }): void {
  const p = pending.get(frame.id)
  if (p === undefined || p.conn !== conn) return
  pending.delete(frame.id)
  writeNdjson(p.res, frame)
  if (!p.res.destroyed && !p.res.writableEnded) p.res.end()
}

/** Create the hub; starts both listeners immediately. */
export function createHub(options: HubOptions): TeamHub {
  const byUser = new Map<string, AgentConn>()
  const byAgentId = new Map<string, AgentConn>()
  const pending = new Map<string, PendingRequest>()
  const heartbeatMs = options.heartbeatMs ?? 15_000

  const agentServer = createNetServer((socket) => {
    socket.setKeepAlive(true, 30_000)
    let conn: AgentConn | null = null
    const reader = makeLineReader(
      (frame) => {
        if (conn === null) {
          conn = authenticate(byUser, byAgentId, options.tokens, socket, frame)
          if (conn !== null) {
            console.log(`[hub] agent online user=${conn.user} agent=${conn.agentId} remote=${conn.remote}`)
          }
          return
        }
        conn.lastSeen = Date.now()
        if (frame === null || typeof frame !== 'object') return
        const msg = frame as { type?: string }
        switch (msg.type) {
          case 'stream':
            relayStream(pending, conn, frame as StreamFrame)
            return
          case 'exit':
          case 'request-error':
            endPending(pending, conn, frame as { id: string })
            return
          default:
            return
        }
      },
      (message) => {
        console.error(`[hub] protocol violation from ${conn?.agentId ?? 'unauthenticated'}: ${message}`)
        socket.destroy()
      },
    )
    socket.on('data', reader)
    socket.on('error', () => { socket.destroy() })
    socket.on('close', () => {
      if (conn === null) return
      byUser.delete(conn.user)
      byAgentId.delete(conn.agentId)
      console.log(`[hub] agent offline user=${conn.user} agent=${conn.agentId}`)
      // Fail open request streams still waiting on the dead channel.
      for (const [id, p] of pending) {
        if (p.conn === conn) {
          pending.delete(id)
          writeNdjson(p.res, { type: 'request-error', id, message: 'agent disconnected' })
          if (!p.res.destroyed && !p.res.writableEnded) p.res.end()
        }
      }
    })
  })

  const heartbeat = setInterval(() => {
    const now = Date.now()
    for (const conn of byAgentId.values()) {
      if (now - conn.lastSeen > 2 * heartbeatMs) {
        conn.socket.destroy()
        continue
      }
      if (!conn.socket.destroyed) conn.socket.write(encodeFrame({ type: 'ping' } as PingFrame))
    }
  }, heartbeatMs)

  async function handleControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://control.invalid')
    if (url.pathname === '/api/agents' && (req.method ?? 'GET') === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(agents(), null, 2))
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain' })
      res.end('method not allowed')
      return
    }

    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      return
    }
    if (body === undefined) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'empty body' }))
      return
    }
    const user = (body as { user?: unknown }).user
    if (typeof user !== 'string') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing string field "user"' }))
      return
    }

    let frame: RequestFrame | undefined
    const id = randomUUID()
    if (url.pathname === '/api/exec') {
      const s = body as { argv?: unknown; cwd?: unknown; timeoutMs?: unknown }
      if (!Array.isArray(s.argv) || s.argv.length === 0 || s.argv.some((a) => typeof a !== 'string')) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'expected non-empty string array field "argv"' }))
        return
      }
      frame = {
        type: 'exec',
        id,
        argv: s.argv as string[],
        ...(typeof s.cwd === 'string' ? { cwd: s.cwd } : {}),
        ...(typeof s.timeoutMs === 'number' ? { timeoutMs: s.timeoutMs } : {}),
      }
    } else if (url.pathname === '/api/fs-read') {
      const s = body as { path?: unknown; maxBytes?: unknown }
      if (typeof s.path !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'expected string field "path"' }))
        return
      }
      frame = {
        type: 'fs:read',
        id,
        path: s.path,
        ...(typeof s.maxBytes === 'number' ? { maxBytes: s.maxBytes } : {}),
      }
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }

    const conn = byUser.get(user)
    if (conn === undefined || conn.socket.destroyed) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `agent offline for user ${user}` }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
    pending.set(frame.id, { res, conn })
    res.on('close', () => { pending.delete(frame.id) })
    if (!conn.socket.destroyed) conn.socket.write(encodeFrame(frame))
  }

  const controlServer = createHttpServer((req, res) => {
    void handleControl(req, res)
  })

  function agents(): AgentRecord[] {
    return [...byAgentId.values()]
      .map(({ socket: _socket, ...record }) => record)
      .sort((a, b) => b.connectedAt - a.connectedAt)
  }

  agentServer.listen(options.agentPort, options.agentHost ?? '0.0.0.0')
  controlServer.listen(options.controlPort, options.controlHost ?? '127.0.0.1')

  return {
    agentPort: options.agentPort,
    controlPort: options.controlPort,
    agents,
    close: () => new Promise<void>((resolveClose) => {
      clearInterval(heartbeat)
      for (const conn of byAgentId.values()) conn.socket.destroy()
      byAgentId.clear()
      byUser.clear()
      for (const [, p] of pending) {
        writeNdjson(p.res, { type: 'request-error', id: 'x', message: 'hub shutting down' })
        if (!p.res.destroyed && !p.res.writableEnded) p.res.end()
      }
      pending.clear()
      let remaining = 2
      const done = () => {
        remaining -= 1
        if (remaining === 0) resolveClose()
      }
      agentServer.close(done)
      controlServer.close(done)
    }),
  }
}
