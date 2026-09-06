/** Loopback HTTP API for the account service. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AuthService } from './auth.ts'
import type { SessionStore } from './session.ts'
import { UserStore } from './users.ts'
import { InstanceStore } from './instances.ts'
import type { InstanceManager } from './instance-manager.ts'
import type { PairingStore } from './pairings.ts'
import type { EnvConfig } from './env.ts'

const COOKIE_NAME = 'dsh_team_session'
const MAX_BODY_BYTES = 16 * 1024

interface HttpServices {
  auth: AuthService
  sessions: SessionStore
  users: UserStore
  instances: InstanceStore
  pairings: PairingStore
  lifecycle: InstanceManager
  sessionTtlSecs: number
  /** Shared secret operator-side services present on instance-registration calls. */
  adminSecret?: string
}

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (header === undefined) return out
  for (const segment of header.split(';')) {
    const eq = segment.indexOf('=')
    if (eq < 0) continue
    const name = segment.slice(0, eq).trim()
    const value = segment.slice(eq + 1).trim()
    if (name !== '') out.set(name, value)
  }
  return out
}

function sessionCookie(sessionId: string, ttlSecs: number): string {
  return [
    `${COOKIE_NAME}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${ttlSecs}`,
  ].join('; ')
}

function expiredSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
      if (raw.length > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (raw === '') { resolve({}); return }
      try {
        resolve(JSON.parse(raw) as unknown)
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

async function handleLogin(req: IncomingMessage, res: ServerResponse, s: HttpServices): Promise<void> {
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, 400, { error: 'invalid request body' })
    return
  }
  const b = body as { username?: unknown; password?: unknown }
  if (typeof b.username !== 'string' || typeof b.password !== 'string' || b.username === '' || b.password === '') {
    sendJson(res, 400, { error: 'username and password are required' })
    return
  }
  const result = await s.auth.login(b.username, b.password)
  if (!result.ok || result.sessionId === undefined) {
    sendJson(res, 401, { error: result.error ?? 'authentication failed' })
    return
  }
  res.setHeader('set-cookie', sessionCookie(result.sessionId, s.sessionTtlSecs))
  if (result.userId === undefined) {
    await s.sessions.destroy(result.sessionId)
    sendJson(res, 500, { error: 'authentication succeeded without a user id' })
    return
  }
  try {
    await s.lifecycle.ensure(result.userId)
  } catch (error) {
    await s.sessions.destroy(result.sessionId)
    sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) })
    return
  }
  sendJson(res, 200, {
    user: {
      userId: result.userId,
      username: result.username,
      role: result.role,
      displayName: result.displayName ?? null,
    },
  })
}

async function handleLogout(req: IncomingMessage, res: ServerResponse, s: HttpServices): Promise<void> {
  const cookies = parseCookies(req.headers.cookie)
  const sessionId = cookies.get(COOKIE_NAME)
  if (sessionId !== undefined) await s.sessions.destroy(sessionId)
  res.setHeader('set-cookie', expiredSessionCookie())
  sendJson(res, 200, { loggedOut: true })
}

/** Route decision for the shell proxy: cookie -> user -> instance port. */
function authorized(req: IncomingMessage, s: HttpServices): boolean {
  if (s.adminSecret === undefined) return true // no secret configured: loopback-only trust
  const header = req.headers['x-team-admin-secret']
  return typeof header === 'string' && header === s.adminSecret
}

/** Register or refresh one user's spawned instance (operator-side). */
async function handleUpsertInstance(req: IncomingMessage, res: ServerResponse, s: HttpServices): Promise<void> {
  if (!authorized(req, s)) { sendJson(res, 403, { error: 'forbidden' }); return }
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'invalid body' }); return }
  const b = body as { user_id?: unknown; port?: unknown; pid?: unknown; launch_token?: unknown }
  if (typeof b.user_id !== 'string' || b.user_id === '' || typeof b.port !== 'number') {
    sendJson(res, 400, { error: 'user_id (string) and port (number) are required' })
    return
  }
  const launchToken = typeof b.launch_token === 'string' && b.launch_token !== '' ? b.launch_token : undefined
  await s.instances.upsert(b.user_id, b.port, launchToken, typeof b.pid === 'number' ? b.pid : undefined)
  sendJson(res, 200, { registered: true, user_id: b.user_id, port: b.port })
}

/** Remove a user's spawned-instance registration (operator-side). */
async function handleDeleteInstance(req: IncomingMessage, res: ServerResponse, s: HttpServices, userId: string): Promise<void> {
  if (!authorized(req, s)) { sendJson(res, 403, { error: 'forbidden' }); return }
  await s.instances.remove(userId)
  sendJson(res, 200, { removed: true, user_id: userId })
}

async function handleSessionRoute(req: IncomingMessage, res: ServerResponse, s: HttpServices): Promise<void> {
  const cookies = parseCookies(req.headers.cookie)
  const sessionId = cookies.get(COOKIE_NAME)
  if (sessionId === undefined) {
    sendJson(res, 401, { authenticated: false, error: 'no session' })
    return
  }
  const userId = await s.sessions.lookup(sessionId)
  if (userId === undefined) {
    sendJson(res, 401, { authenticated: false, error: 'invalid or expired session' })
    return
  }
  const user = await s.users.findByUsername(userId)
  if (user === undefined || user.status !== 'active') {
    sendJson(res, 401, { authenticated: false, error: 'account unavailable' })
    return
  }
  const route = await s.instances.routeFor(user.user_id)
  if (route === undefined) {
    sendJson(res, 200, { authenticated: true, instance: null })
    return
  }
  sendJson(res, 200, {
    authenticated: true,
    instance: { port: route.port, launchToken: route.launchToken },
  })
}

async function handleMe(req: IncomingMessage, res: ServerResponse, s: HttpServices): Promise<void> {
  const cookies = parseCookies(req.headers.cookie)
  const sessionId = cookies.get(COOKIE_NAME)
  if (sessionId === undefined) {
    sendJson(res, 401, { authenticated: false })
    return
  }
  const userId = await s.sessions.lookup(sessionId)
  if (userId === undefined) {
    sendJson(res, 401, { authenticated: false })
    return
  }
  const user = await s.users.findByUsername(userId)
  if (user === undefined) {
    sendJson(res, 401, { authenticated: false })
    return
  }
  const port = await s.instances.portFor(user.user_id)
  sendJson(res, 200, {
    authenticated: true,
    user: {
      userId: user.user_id,
      username: user.username,
      role: user.role,
      displayName: user.display_name,
    },
    instance: port === undefined ? null : { port },
  })
}

/** Resolve the current session's user from cookies, or undefined. */
export async function sessionUser(req: IncomingMessage, s: HttpServices): Promise<{ userId: string; username: string } | undefined> {
  const cookies = parseCookies(req.headers.cookie)
  const sessionId = cookies.get(COOKIE_NAME)
  if (sessionId === undefined) return undefined
  const userId = await s.sessions.lookup(sessionId)
  if (userId === undefined) return undefined
  const user = await s.users.findByUsername(userId)
  return user === undefined ? undefined : { userId: user.user_id, username: user.username }
}

/** Mint a pairing code for the signed-in member (never exposes the agent token). */
async function handleMintPairing(req: IncomingMessage, res: ServerResponse, s: HttpServices): Promise<void> {
  const user = await sessionUser(req, s)
  if (user === undefined) {
    sendJson(res, 401, { error: 'no session' })
    return
  }
  const record = await s.pairings.mint(user.userId)
  sendJson(res, 200, {
    uuid: record.uuid,
    user: record.user,
    expiresAt: record.expiresAt,
    ttlMs: record.ttlMs,
  })
}

/** Verify a pairing code for the hub (server-to-server, operator-secret guarded). */
async function handleClaimPairing(req: IncomingMessage, res: ServerResponse, s: HttpServices): Promise<void> {
  if (!authorized(req, s)) { sendJson(res, 403, { error: 'forbidden' }); return }
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'invalid body' }); return }
  const b = body as { uuid?: unknown }
  if (typeof b.uuid !== 'string' || b.uuid === '') {
    sendJson(res, 400, { error: 'uuid (string) is required' })
    return
  }
  const userId = await s.pairings.lookup(b.uuid)
  if (userId === undefined) {
    sendJson(res, 404, { error: 'pairing code not found or expired' })
    return
  }
  const user = await s.users.findByUsername(userId)
  if (user === undefined || user.status !== 'active') {
    sendJson(res, 404, { error: 'pairing code not found or expired' })
    return
  }
  // Server-to-server only: the hub receives the agent token so it can bind the
  // claiming agent and issue a reconnect token. The browser never sees this.
  sendJson(res, 200, { user: user.user_id, agentToken: user.agent_token })
}

export function createAccountServer(s: HttpServices) {
  return createServer((req, res) => {
    const url = req.url ?? '/'
    const path = url.split('?')[0] ?? '/'
    const method = req.method ?? 'GET'
    void (async () => {
      try {
        if (path === '/health' && method === 'GET') {
          sendJson(res, 200, { ok: true })
        } else if (path === '/api/login' && method === 'POST') {
          await handleLogin(req, res, s)
        } else if (path === '/api/logout' && method === 'POST') {
          await handleLogout(req, res, s)
        } else if (path === '/api/me' && method === 'GET') {
          await handleMe(req, res, s)
        } else if (path === '/api/session/route' && method === 'GET') {
          await handleSessionRoute(req, res, s)
        } else if (path === '/api/pairings' && method === 'POST') {
          await handleMintPairing(req, res, s)
        } else if (path === '/api/pairings/claim' && method === 'POST') {
          await handleClaimPairing(req, res, s)
        } else if (path === '/api/instances' && method === 'POST') {
          await handleUpsertInstance(req, res, s)
        } else if (path.startsWith('/api/instances/') && method === 'DELETE') {
          await handleDeleteInstance(req, res, s, decodeURIComponent(path.slice('/api/instances/'.length)))
        } else {
          sendJson(res, 404, { error: `no route for ${method} ${path}` })
        }
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    })()
  })
}
