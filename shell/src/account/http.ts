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
import { RegistrationError, type RegistrationService } from './registrations.ts'
import { verifyPassword } from './password.ts'
import { approvalPage, changePasswordPage, registerPage, resultPage } from '../team-pages.ts'

const COOKIE_NAME = 'dsh_team_session'
const MAX_BODY_BYTES = 16 * 1024

/** Shortest accepted password for a member-chosen replacement. */
const MIN_PASSWORD_LENGTH = 8

/** Longest accepted password, bounding the scrypt input. */
const MAX_PASSWORD_LENGTH = 200

interface HttpServices {
  auth: AuthService
  sessions: SessionStore
  users: UserStore
  instances: InstanceStore
  pairings: PairingStore
  lifecycle: InstanceManager
  registrations: RegistrationService
  sessionTtlSecs: number
  /** Email domains the registration form accepts, shown on the page. */
  registrationDomains: readonly string[]
  /** Password issued to an approved account, shown on the registration page. */
  defaultPassword: string
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

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
      if (raw.length > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => { resolve(raw) })
    req.on('error', reject)
  })
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req)
  if (raw === '') return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error('invalid JSON body')
  }
}

/** Parse an `application/x-www-form-urlencoded` body (the approval form's post). */
async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readRawBody(req))
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
  if (sessionId !== undefined) {
    const userId = await s.sessions.lookup(sessionId)
    await s.sessions.destroy(sessionId)
    // Signing out actively reclaims the user's instance (supervisor + dsh
    // web), matching the S6 lifecycle goal; the next login cold-starts.
    if (userId !== undefined) await s.lifecycle.stop(userId)
  }
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
  // The proxy asks this on every forwarded request, so a resolved instance is
  // itself the activity signal: refresh its idle clock so the reclaim sweep
  // never collects a session that is still in use.
  await s.instances.touch(user.user_id)
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
      idleExempt: user.idle_exempt,
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

/** Self-service toggle against the idle-instance reclaim sweep (own account only). */
async function handleSetIdleExempt(req: IncomingMessage, res: ServerResponse, s: HttpServices): Promise<void> {
  const user = await sessionUser(req, s)
  if (user === undefined) {
    sendJson(res, 401, { error: 'no session' })
    return
  }
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'invalid body' }); return }
  const b = body as { exempt?: unknown }
  if (typeof b.exempt !== 'boolean') {
    sendJson(res, 400, { error: 'exempt (boolean) is required' })
    return
  }
  await s.users.setIdleExempt(user.userId, b.exempt)
  sendJson(res, 200, { idleExempt: b.exempt })
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

/** The public registration form, rendered by the service that owns its policy. */
function handleRegisterPage(res: ServerResponse, s: HttpServices): void {
  sendHtml(res, 200, registerPage(s.registrationDomains, s.defaultPassword))
}

/**
 * Accept one registration request and notify the operator. Reachable without a
 * session by design — the operator's approval, not authentication, is what
 * creates an account.
 */
async function handleRegister(req: IncomingMessage, res: ServerResponse, s: HttpServices): Promise<void> {
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'invalid request body' }); return }
  const b = body as { email?: unknown; name?: unknown }
  if (typeof b.email !== 'string' || b.email === '') {
    sendJson(res, 400, { error: '请填写有效的邮箱地址' })
    return
  }
  const name = typeof b.name === 'string' ? b.name : undefined
  try {
    const opened = await s.registrations.open(b.email, name)
    sendJson(res, 200, { pending: true, username: opened.username })
  } catch (error) {
    if (error instanceof RegistrationError) { sendJson(res, error.status, { error: error.message }); return }
    throw error
  }
}

/** Render the operator's approval page for one token. */
async function handleApprovalPage(req: IncomingMessage, res: ServerResponse, s: HttpServices): Promise<void> {
  const token = new URL(req.url ?? '/', 'http://account.invalid').searchParams.get('token')
  if (token === null || token === '') {
    sendHtml(res, 400, resultPage('缺少审批令牌', '该链接不完整，请使用飞书通知里的完整链接。', false))
    return
  }
  const pending = await s.registrations.pending(token)
  if (pending === undefined) {
    sendHtml(res, 404, resultPage(
      '链接已失效',
      '该审批链接已被处理、已过期，或从未有效。\n若仍需开通账号，请让申请人重新提交一次。',
      false,
    ))
    return
  }
  const requestedAt = new Date(pending.created_at)
  sendHtml(res, 200, approvalPage([
    ['邮箱', pending.email],
    ['用户名', pending.username],
    ...pending.display_name === null ? [] : [['姓名', pending.display_name] as const],
    ['申请时间', Number.isNaN(requestedAt.getTime())
      ? pending.created_at
      : requestedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })],
  ], token))
}

/**
 * Spend an approval token. The decision arrives as a form post so a link
 * preview or crawler fetching the notification URL can never approve an
 * account; only the operator pressing a button on the rendered page does.
 */
async function handleApprovalDecision(req: IncomingMessage, res: ServerResponse, s: HttpServices): Promise<void> {
  const form = await readFormBody(req)
  const token = form.get('token')
  const action = form.get('action')
  if (token === null || token === '' || (action !== 'approve' && action !== 'reject')) {
    sendHtml(res, 400, resultPage('请求无效', '审批请求缺少必要的参数。', false))
    return
  }
  let outcome: Awaited<ReturnType<RegistrationService['decide']>>
  try {
    outcome = await s.registrations.decide(token, action === 'approve', 'operator-link')
  } catch (error) {
    if (error instanceof RegistrationError) {
      sendHtml(res, error.status, resultPage('未能创建账号', error.message, false))
      return
    }
    throw error
  }
  if (!outcome.ok) {
    sendHtml(res, 404, resultPage('链接已失效', '该审批链接已被处理或已过期。', false))
    return
  }
  const { registration } = outcome
  sendHtml(res, 200, outcome.action === 'approve'
    ? resultPage('已创建账号', [
      `用户名：${registration.username}`,
      `初始密码：${s.defaultPassword}`,
      '',
      '已通知申请人用该密码登录；用户登录后可自行修改密码。',
    ].join('\n'), true)
    : resultPage('已拒绝申请', `已拒绝 ${registration.email} 的注册申请，未创建任何账号。`, true))
}

/** The signed-in password-change form. */
async function handleChangePasswordPage(req: IncomingMessage, res: ServerResponse, s: HttpServices): Promise<void> {
  const user = await sessionUser(req, s)
  if (user === undefined) {
    res.writeHead(302, { location: '/' })
    res.end()
    return
  }
  sendHtml(res, 200, changePasswordPage(user.username))
}

/** Replace the signed-in member's password after re-checking the current one. */
async function handleChangePassword(req: IncomingMessage, res: ServerResponse, s: HttpServices): Promise<void> {
  const session = await sessionUser(req, s)
  if (session === undefined) { sendJson(res, 401, { error: '请先登录' }); return }
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'invalid request body' }); return }
  const b = body as { currentPassword?: unknown; newPassword?: unknown }
  if (typeof b.currentPassword !== 'string' || typeof b.newPassword !== 'string') {
    sendJson(res, 400, { error: '请填写当前密码和新密码' })
    return
  }
  if (b.newPassword.length < MIN_PASSWORD_LENGTH || b.newPassword.length > MAX_PASSWORD_LENGTH) {
    sendJson(res, 400, { error: `新密码长度需在 ${String(MIN_PASSWORD_LENGTH)}-${String(MAX_PASSWORD_LENGTH)} 个字符之间` })
    return
  }
  const user = await s.users.findByUsername(session.username)
  if (user === undefined) { sendJson(res, 401, { error: '请先登录' }); return }
  if (!verifyPassword(b.currentPassword, user.password_hash)) {
    sendJson(res, 403, { error: '当前密码不正确' })
    return
  }
  if (b.newPassword === b.currentPassword) {
    sendJson(res, 400, { error: '新密码不能与当前密码相同' })
    return
  }
  await s.users.setPassword(user.user_id, b.newPassword)
  sendJson(res, 200, { changed: true })
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
        } else if (path === '/register' && method === 'GET') {
          handleRegisterPage(res, s)
        } else if (path === '/api/register' && method === 'POST') {
          await handleRegister(req, res, s)
        } else if (path === '/approve' && method === 'GET') {
          await handleApprovalPage(req, res, s)
        } else if (path === '/api/approvals' && method === 'POST') {
          await handleApprovalDecision(req, res, s)
        } else if (path === '/password' && method === 'GET') {
          await handleChangePasswordPage(req, res, s)
        } else if (path === '/api/me/password' && method === 'POST') {
          await handleChangePassword(req, res, s)
        } else if (path === '/api/login' && method === 'POST') {
          await handleLogin(req, res, s)
        } else if (path === '/api/logout' && method === 'POST') {
          await handleLogout(req, res, s)
        } else if (path === '/api/me' && method === 'GET') {
          await handleMe(req, res, s)
        } else if (path === '/api/me/idle-exempt' && method === 'POST') {
          await handleSetIdleExempt(req, res, s)
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
