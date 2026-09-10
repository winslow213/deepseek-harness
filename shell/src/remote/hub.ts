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
  /** Root directory under which mount shadow directories live (default `/var/lib/dsh-mounts`). */
  shadowRoot?: string
  /** Interval between hub heartbeat pings to each agent. */
  heartbeatMs?: number
  /** Lifetime of a hub-minted (CLI) pairing code in milliseconds. */
  pairingTtlMs?: number
  /**
   * Account-service base URL. When set, a pairing code the hub does not mint
   * itself is verified by asking the account service (which owns the code
   * store and the authoritative agent token); the hub learns that token for
   * later reconnects.
   */
  accountUrl?: string
  /** Shared secret presented on account-service claim calls. */
  adminSecret?: string
  /**
   * Fired when an agent completes a pairing handshake and registers. The hub
   * binds the agent to the pairing's user before calling this; the caller
   * (typically the shell CLI) may then auto-inject the remote providers into
   * that user's profile.
   */
  onPaired?: (pairing: ConsumedPairing) => void
}

/** A pairing code awaiting an agent. */
export interface PendingPairing {
  uuid: string
  user: string
  createdAt: number
  expiresAt: number
}

/** The pairing record handed to `onPaired` once an agent consumes a code. */
export interface ConsumedPairing {
  uuid: string
  user: string
  /** Agent details registered for the user after the pairing handshake. */
  agent: AgentRecord
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

/**
 * One mountable region from a connected agent: the agent's served root,
 * addressable server-side under a real shadow directory. Workspaces reference
 * the shadow path (so dsh's realpath/stat checks pass); a RegionRouter maps
 * shadow-path accesses back to the agent's hub user and real root. Shadow
 * directories are created lazily when the user adds the mount as a workspace
 * and removed when it is unloaded; the mapping itself lives only in hub
 * memory (no mapping file).
 */
export interface MountRecord {
  /** Agent serving this root. */
  agentId: string
  /** Hub user whose agent owns the root. */
  user: string
  /** The real root path on the agent host (e.g. `D:\workspace`). */
  root: string
  /** Real shadow directory on the server for this root (e.g. `/var/lib/dsh-mounts/alice/wh1`). */
  shadowPath: string
}

/**
 * Build the server-side shadow directory path for one agent root. The shadow
 * path is a real absolute directory under the configured shadow root that dsh
 * treats as a normal workspace path; a RegionRouter translates accesses under
 * it to the agent's served root.
 */
export function shadowPathFor(user: string, agentId: string, root: string, ordinal: number, shadowRoot: string): string {
  const agentSegment = agentId.replace(/[^\w@.-]/g, '_')
  const rootSegment = ordinal === 0 ? '' : `/root${ordinal}`
  return `${shadowRoot.replace(/\/+$/, '')}/${user}/${agentSegment}${rootSegment}`
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
  /** Mountable region view: every online agent's roots mapped under a virtual server prefix. */
  mounts(): MountRecord[]
  /** Pending (unconsumed) pairing codes, newest first. */
  pairings(): PendingPairing[]
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

/** Account-service pairing-claim result (server-to-server, never browser-visible). */
interface AccountClaim {
  user: string
  agentToken: string
}

/** Account-service base + secret for verifying externally minted codes. */
interface AccountVerifier {
  accountUrl: string
  adminSecret?: string
}

/** Verify an account-service-minted pairing code over loopback HTTP. */
async function accountClaim(account: AccountVerifier | undefined, uuid: string): Promise<AccountClaim | undefined> {
  if (account === undefined) return undefined
  try {
    const res = await fetch(`${account.accountUrl.replace(/\/+$/, '')}/api/pairings/claim`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...account.adminSecret === undefined ? {} : { 'x-team-admin-secret': account.adminSecret },
      },
      body: JSON.stringify({ uuid }),
    })
    if (!res.ok) return undefined
    const body = await res.json() as { user?: unknown; agentToken?: unknown }
    if (typeof body.user !== 'string' || body.user === '' || typeof body.agentToken !== 'string') return undefined
    return { user: body.user, agentToken: body.agentToken }
  } catch {
    return undefined
  }
}

/**
 * Validate and authenticate an agent `hello`, registering it on success.
 * Two auth modes: token mode (`user`+`token`) and pairing mode (`pairUuid`).
 * A hub-minted (CLI) code is one-time; an account-service-minted code is
 * multi-use within its TTL (the account service owns its expiry), so one code
 * can bind several agents for the same user. On any pairing the hub learns the
 * account's authoritative token so a later `--user/--token` reconnect works.
 */
async function authenticate(
  byUser: Map<string, AgentConn[]>,
  byAgentId: Map<string, AgentConn>,
  tokens: Map<string, string>,
  pairings: Map<string, PendingPairing>,
  account: AccountVerifier | undefined,
  onPaired: ((pairing: ConsumedPairing) => void) | undefined,
  socket: Socket,
  frame: unknown,
): Promise<AgentConn | null> {
  const sendError = (message: string) => {
    if (!socket.destroyed) socket.write(encodeFrame({ type: 'error', message }))
  }
  if (frame === null || typeof frame !== 'object') {
    sendError('malformed hello')
    socket.destroy()
    return null
  }
  const hello = frame as Partial<HelloFrame>
  if (hello.type !== 'hello' || typeof hello.agentId !== 'string' || !Array.isArray(hello.roots)) {
    sendError('malformed hello')
    socket.destroy()
    return null
  }

  let user: string | undefined
  let issuedToken: string | undefined
  if (typeof hello.pairUuid === 'string' && hello.pairUuid !== '') {
    const local = pairings.get(hello.pairUuid)
    if (local !== undefined && Date.now() <= local.expiresAt) {
      // Hub-minted CLI code: one-time.
      pairings.delete(hello.pairUuid)
      user = local.user
      issuedToken = tokens.get(local.user)
    } else {
      if (local !== undefined) pairings.delete(hello.pairUuid)
      const claim = await accountClaim(account, hello.pairUuid)
      if (claim === undefined) {
        sendError('pairing code not found or expired')
        socket.destroy()
        return null
      }
      user = claim.user
      issuedToken = claim.agentToken
      tokens.set(claim.user, claim.agentToken)
    }
    if (onPaired !== undefined) {
      const record: AgentRecord = {
        agentId: hello.agentId,
        user: user as string,
        remote: `${socket.remoteAddress ?? '?'}:${String(socket.remotePort ?? '?')}`,
        roots: hello.roots ?? [],
        commands: hello.commands ?? [],
        connectedAt: Date.now(),
        lastSeen: Date.now(),
      }
      onPaired({ uuid: hello.pairUuid, user: user as string, agent: record })
    }
  } else if (typeof hello.user === 'string' && typeof hello.token === 'string') {
    const expected = tokens.get(hello.user)
    if (expected === undefined || expected !== hello.token) {
      sendError('authentication failed')
      socket.destroy()
      return null
    }
    user = hello.user
  } else {
    sendError('hello must carry user+token or a pairing code')
    socket.destroy()
    return null
  }

  const conn: AgentConn = {
    agentId: hello.agentId,
    user: user as string,
    remote: `${socket.remoteAddress ?? '?'}:${String(socket.remotePort ?? '?')}`,
    roots: hello.roots ?? [],
    commands: hello.commands ?? [],
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    socket,
  }
  // A newer connection for the same agent id replaces the old one. Distinct
  // agents for the same user coexist (multi-device), keyed by agent id.
  byAgentId.get(conn.agentId)?.socket.destroy()
  byAgentId.set(conn.agentId, conn)
  const list = byUser.get(conn.user) ?? []
  list.push(conn)
  byUser.set(conn.user, list)
  if (!socket.destroyed) {
    // A pairing-proven agent receives the user's token so a later reconnect can
    // authenticate with --user/--token.
    socket.write(encodeFrame({
      type: 'hello_ack',
      agentId: conn.agentId,
      user: conn.user,
      ...issuedToken === undefined ? {} : { token: issuedToken },
    }))
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
  const byUser = new Map<string, AgentConn[]>()
  const byAgentId = new Map<string, AgentConn>()
  const pairings = new Map<string, PendingPairing>()
  const pending = new Map<string, PendingRequest>()
  const tokens = new Map(options.tokens)
  const heartbeatMs = options.heartbeatMs ?? 15_000
  const pairingTtlMs = options.pairingTtlMs ?? 10 * 60 * 1000
  const onPaired = options.onPaired
  const shadowRoot = options.shadowRoot ?? '/var/lib/dsh-mounts'
  const account = options.accountUrl === undefined || options.accountUrl === ''
    ? undefined
    : { accountUrl: options.accountUrl, adminSecret: options.adminSecret }

  const agentServer = createNetServer((socket) => {
    socket.setKeepAlive(true, 30_000)
    let conn: AgentConn | null = null
    let authenticating = false
    const reader = makeLineReader(
      (frame) => {
        if (conn !== null) {
          conn.lastSeen = Date.now()
          if (frame === null || typeof frame !== 'object') return
          const msg = frame as { type?: string }
          switch (msg.type) {
            case 'stream':
              relayStream(pending, conn, frame as StreamFrame)
              return
            case 'fs:result':
            case 'exit':
            case 'request-error':
              endPending(pending, conn, frame as { id: string })
              return
            default:
              return
          }
          return
        }
        // The first frame is the hello; while it is being verified, drop any
        // early frames (an agent waits for hello_ack before sending more).
        if (authenticating) return
        authenticating = true
        void authenticate(byUser, byAgentId, tokens, pairings, account, onPaired, socket, frame)
          .then((result) => {
            if (result === null) return
            conn = result
            authenticating = false
            console.log(`[hub] agent online user=${conn.user} agent=${conn.agentId} remote=${conn.remote}`)
          })
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
      // Remove only this connection's registration. Distinct agents for the
      // same user coexist, so the per-user list drops only this agent id.
      const list = byUser.get(conn.user)
      if (list !== undefined) {
        const next = list.filter(c => c !== conn)
        if (next.length === 0) byUser.delete(conn.user)
        else byUser.set(conn.user, next)
      }
      if (byAgentId.get(conn.agentId) === conn) byAgentId.delete(conn.agentId)
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
    // Drop expired pairing codes alongside the liveness sweep.
    for (const [uuid, pairing] of pairings) {
      if (now > pairing.expiresAt) pairings.delete(uuid)
    }
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
    if (url.pathname === '/api/pairings' && (req.method ?? 'GET') === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(pairingList(), null, 2))
      return
    }
    if (url.pathname === '/api/mounts' && (req.method ?? 'GET') === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(mounts(), null, 2))
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

    // Create a one-time pairing code. The requester proves ownership of the
    // user's agent token (the same secret the agent dials with), so anyone who
    // can mint a code can already impersonate the user's agent.
    if (url.pathname === '/api/pairings') {
      const s = body as { user?: unknown; secret?: unknown }
      const user = typeof s.user === 'string' ? s.user : ''
      const secret = typeof s.secret === 'string' ? s.secret : ''
      const expected = tokens.get(user)
      if (expected === undefined || expected !== secret) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'user/secret mismatch' }))
        return
      }
      const now = Date.now()
      const pairing: PendingPairing = {
        uuid: randomUUID(),
        user,
        createdAt: now,
        expiresAt: now + pairingTtlMs,
      }
      pairings.set(pairing.uuid, pairing)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ uuid: pairing.uuid, user, expiresAt: pairing.expiresAt, ttlMs: pairingTtlMs }))
      return
    }

    const user = (body as { user?: unknown }).user
    if (typeof user !== 'string') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing string field "user"' }))
      return
    }

    let frame: RequestFrame | undefined
    // Clients that must kill an exec provide their own id so they can address
    // it before any output frame returns (a silent command's first frame is
    // its exit). The executor supplies a uuid; CLI callers let the hub default.
    const bodyId = (body as { id?: unknown }).id
    const id = typeof bodyId === 'string' && bodyId !== '' ? bodyId : randomUUID()
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
    } else if (url.pathname === '/api/kill') {
      const s = body as { id?: unknown }
      if (typeof s.id !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'expected string field "id"' }))
        return
      }
      frame = { type: 'kill', id: s.id }
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
    } else if (url.pathname === '/api/fs') {
      // One filesystem primitive: fs:op frames in the agent fs protocol.
      const s = body as {
        op?: unknown; path?: unknown; maxBytes?: unknown; content?: unknown
        expected?: unknown; oldString?: unknown; newString?: unknown; replaceAll?: unknown
        offset?: unknown; length?: unknown
      }
      const fsOps = ['resolve', 'stat', 'lstat', 'list', 'readText', 'readBytes', 'readByteRange', 'write', 'edit']
      if (typeof s.op !== 'string' || !fsOps.includes(s.op)) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `expected op in ${fsOps.join('|')}` }))
        return
      }
      frame = {
        type: 'fs:op',
        id,
        op: s.op as 'stat' | 'lstat' | 'list' | 'readText' | 'readBytes' | 'readByteRange' | 'write' | 'edit' | 'resolve',
        ...(typeof s.path === 'string' ? { path: s.path } : {}),
        ...(typeof s.maxBytes === 'number' ? { maxBytes: s.maxBytes } : {}),
        ...(typeof s.offset === 'number' ? { offset: s.offset } : {}),
        ...(typeof s.length === 'number' ? { length: s.length } : {}),
        ...(typeof s.content === 'string' ? { content: s.content } : {}),
        ...(typeof s.expected === 'object' && s.expected !== null ? { expected: s.expected as { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: string } } : {}),
        ...(typeof s.oldString === 'string' ? { oldString: s.oldString } : {}),
        ...(typeof s.newString === 'string' ? { newString: s.newString } : {}),
        ...(typeof s.replaceAll === 'boolean' ? { replaceAll: s.replaceAll } : {}),
      }
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }

    const bodyAgentId = (body as { agentId?: unknown }).agentId
    const agentId = typeof bodyAgentId === 'string' && bodyAgentId !== '' ? bodyAgentId : undefined
    let conn: AgentConn | undefined
    if (agentId !== undefined) {
      const c = byAgentId.get(agentId)
      conn = c !== undefined && c.user === user && !c.socket.destroyed ? c : undefined
    } else {
      const live = (byUser.get(user) ?? []).filter(c => !c.socket.destroyed)
      if (live.length === 1) {
        conn = live[0]
      } else if (live.length > 1) {
        res.writeHead(409, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `multiple agents online for user ${user}; specify agentId` }))
        return
      }
    }
    if (conn === undefined) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `agent offline for user ${user}` }))
      return
    }
    // Kill is fire-and-forget: forward it and answer immediately. The agent
    // ends the matching exec's own NDJSON response when the process dies.
    if (frame.type === 'kill') {
      if (!conn.socket.destroyed) conn.socket.write(encodeFrame(frame))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
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

  function mounts(): MountRecord[] {
    const result: MountRecord[] = []
    for (const agent of byAgentId.values()) {
      agent.roots.forEach((root, ordinal) => {
        const shadowPath = shadowPathFor(agent.user, agent.agentId, root, ordinal, shadowRoot)
        result.push({
          agentId: agent.agentId,
          user: agent.user,
          root,
          shadowPath,
        })
      })
    }
    return result.sort((a, b) => a.shadowPath.localeCompare(b.shadowPath))
  }

  function pairingList(): PendingPairing[] {
    return [...pairings.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  agentServer.listen(options.agentPort, options.agentHost ?? '0.0.0.0')
  controlServer.listen(options.controlPort, options.controlHost ?? '127.0.0.1')

  return {
    agentPort: options.agentPort,
    controlPort: options.controlPort,
    agents,
    mounts,
    pairings: pairingList,
    close: () => new Promise<void>((resolveClose) => {
      clearInterval(heartbeat)
      pairings.clear()
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
