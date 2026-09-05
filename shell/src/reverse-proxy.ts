/**
 * Reverse proxy for the team shell. Two modes:
 *
 * 1. Static mode: aggregates per-user dsh web instances behind one entry host.
 *    Routes are a map of path prefix -> upstream; a `''` prefix is the default
 *    upstream catching every unmatched path.
 *
 * 2. Account mode: the proxy fronts a per-user dsh web per member account. A
 *    member visits the entry, logs in through the account service (its
 *    /api/login proxied here), and the proxy routes the authenticated session
 *    to the member's spawned instance port.
 *
 * The dsh web trust model requires the Host header seen by the instance to be
 * the authority the browser authenticated against. Both modes forward the
 * original Host header untouched, so cookies stay bound to the entry authority
 * and every proxied request passes the instance's Host/Origin fence. Each dsh
 * web instance must be started with `--trusted-host <entry-host>`.
 *
 * @module dsh-team-shell/reverse-proxy
 */

import { createHash } from 'node:crypto'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/** One upstream dsh web instance. */
export interface Upstream {
  /** User id owning the instance (also its DSH_HOME name). */
  readonly user: string
  /** Loopback port the instance listens on. */
  readonly port: number
}

export interface ProxyOptions {
  /** Port the proxy entry listens on. */
  readonly port: number
  /** Upstream map keyed by path prefix (e.g. `/u/alice`). */
  readonly routes: ReadonlyMap<string, Upstream>
}

/** Session cookie name shared with the team account service. */
export const TEAM_SESSION_COOKIE = 'dsh_team_session'

/** Minimal login page served when a request carries no valid session. */
const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>天问星 · 登录</title>
<style>
  :root { color-scheme: dark; }
  body {
    font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    margin: 0; min-height: 100vh; color: #e8edf7;
    background: radial-gradient(ellipse at 50% 120%, #0b1e3f 0%, #060a18 60%, #04060f 100%);
    display: grid; place-items: center; overflow: hidden;
  }
  /* star field */
  .stars { position: fixed; inset: 0; background-image:
      radial-gradient(1px 1px at 20% 30%, #fff8, transparent),
      radial-gradient(1px 1px at 70% 20%, #fff6, transparent),
      radial-gradient(1.5px 1.5px at 40% 70%, #aebfff, transparent),
      radial-gradient(1px 1px at 85% 60%, #fff9, transparent),
      radial-gradient(1px 1px at 10% 85%, #fff5, transparent),
      radial-gradient(1.5px 1.5px at 60% 90%, #8fa8ff, transparent),
      radial-gradient(1px 1px at 30% 45%, #ffffff88, transparent),
      radial-gradient(1px 1px at 90% 15%, #ffffff66, transparent);
    pointer-events: none; }
  .card {
    position: relative; z-index: 1; width: 22rem; text-align: center;
    background: rgba(13, 24, 54, .55); border: 1px solid rgba(120, 160, 255, .25);
    border-radius: 16px; padding: 2.6rem 2.2rem 2.2rem; backdrop-filter: blur(8px);
    box-shadow: 0 0 60px rgba(30, 70, 200, .25);
  }
  .brand { font-size: 2.1rem; font-weight: 700; letter-spacing: .3em; margin: 0 0 .3rem;
    background: linear-gradient(120deg, #8ab6ff, #dfe9ff, #7fa0ff);
    -webkit-background-clip: text; background-clip: text; color: transparent; }
  .tagline { font-size: .82rem; color: #93a4cc; margin: 0 0 2rem; letter-spacing: .08em; }
  form { text-align: left; }
  label { display: block; margin: .9rem 0 .3rem; font-size: .85rem; color: #b8c6e2; }
  input {
    width: 100%; box-sizing: border-box; padding: .65rem .8rem;
    background: rgba(255,255,255,.05); border: 1px solid rgba(140,170,255,.3);
    border-radius: 8px; color: #eef2fb; font-size: .95rem; outline: none;
  }
  input:focus { border-color: #6f9bff; box-shadow: 0 0 0 3px rgba(111,155,255,.15); }
  button {
    width: 100%; margin-top: 1.6rem; padding: .7rem; border: 0; border-radius: 8px;
    background: linear-gradient(120deg, #2f6bff, #5b8cff); color: #fff;
    font-size: .98rem; letter-spacing: .2em; cursor: pointer; transition: filter .15s;
  }
  button:hover { filter: brightness(1.12); }
  #err { color: #ff7d7d; min-height: 1em; font-size: .85rem; margin-top: .8rem; text-align: center; }
</style></head>
<body>
<div class="stars"></div>
<div class="card">
  <h1 class="brand">天问星</h1>
  <p class="tagline">鸿蒙科专用 Agent 赋能研发平台</p>
  <form id="f">
    <label for="u">用户名</label><input id="u" autocomplete="username" required>
    <label for="p">密码</label><input id="p" type="password" autocomplete="current-password" required>
    <button type="submit">登 录</button>
    <div id="err"></div>
  </form>
</div>
<script>
const f = document.getElementById('f')
f.addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = document.getElementById('err')
  err.textContent = ''
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: document.getElementById('u').value, password: document.getElementById('p').value }),
    })
    if (!r.ok) { err.textContent = '用户名或密码错误'; return }
    window.location.href = '/'
  } catch { err.textContent = '网络错误' }
})
</script></body></html>`

/** The "instance not ready" page for an authenticated member with no spawned instance. */
const NOT_READY_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Instance not ready</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9}
.card{background:#fff;border:1px solid #d9dee3;border-radius:12px;padding:2rem;width:24rem;text-align:center}
h1{font-size:1.2rem}code{background:#eef1f4;padding:.15rem .4rem;border-radius:4px}</style></head>
<body><div class="card"><h1>Your dsh instance is not running</h1>
<p>An operator has not started your instance yet. Ask them to run
<code>spawn-user &lt;your-user&gt; &lt;port&gt;</code> and try again.</p>
<p><a href="/api/logout" id="lo">Sign out</a></p></div></body></html>`

/** Proxy one HTTP request to the upstream, stripping the route prefix. */
function proxyHttp(req: IncomingMessage, res: ServerResponse, upstream: Upstream, prefix: string): void {
  const pathname = req.url ?? '/'
  const stripped = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname
  const forward = httpRequest({
    hostname: '127.0.0.1',
    port: upstream.port,
    method: req.method ?? 'GET',
    path: stripped === '' ? '/' : stripped,
    // Forward the browser's original Host header: the instance fence and
    // cookie authority then agree with what the user authenticated against.
    headers: req.headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
    upstreamRes.pipe(res)
  })
  forward.on('error', (error: Error) => {
    if (!res.headersSent) res.writeHead(502)
    res.end(`proxy error: ${error.message}`)
  })
  req.pipe(forward)
}


/**
 * Proxy one request to the upstream, injecting the team logout overlay into
 * HTML documents. Non-HTML responses and everything after a page's first byte
 * stream through unchanged; an HTML body is buffered so the badge can be
 * inserted before </body>.
 */
function proxyHtml(req: IncomingMessage, res: ServerResponse, upstream: Upstream, prefix: string): void {
  const pathname = req.url ?? '/'
  const stripped = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname
  const forward = httpRequest({
    hostname: '127.0.0.1',
    port: upstream.port,
    method: req.method ?? 'GET',
    path: stripped === '' ? '/' : stripped,
    headers: req.headers,
  }, (upstreamRes) => {
    const type = upstreamRes.headers['content-type']
    const isHtml = typeof type === 'string' && type.includes('text/html')
    if (!isHtml) {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
      return
    }
    // Buffer HTML so the badge can be injected; page documents are small and
    // the product streams its app assets as separate non-HTML requests.
    const chunks: Buffer[] = []
    let total = 0
    const cap = 8 * 1024 * 1024
    upstreamRes.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > cap) {
        // Oversized document: stream what we buffered plus the rest unchanged.
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        res.end(Buffer.concat(chunks))
        upstreamRes.pipe(res)
        return
      }
      chunks.push(chunk)
    })
    upstreamRes.on('end', () => {
      if (res.headersSent) return
      const headers = { ...upstreamRes.headers }
      const encoding = (upstreamRes.headers['content-encoding'] ?? '').toLowerCase()
      let body: string
      try {
        const raw = Buffer.concat(chunks)
        if (encoding === 'gzip') body = gunzipSync(raw).toString('utf8')
        else if (encoding === 'deflate') body = inflateSync(raw).toString('utf8')
        else if (encoding === 'br') body = brotliDecompressSync(raw).toString('utf8')
        else body = raw.toString('utf8')
      } catch {
        // Undecodable body (binary masquerading as html): pass the original through.
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        res.end(Buffer.concat(chunks))
        return
      }
      const injected = injectLogoutBadge(body)
      // The injected body is re-sent identity-encoded; drop the compression
      // headers so the browser does not try to inflate uncompressed bytes.
      delete headers['content-length']
      delete headers['content-encoding']
      delete headers['transfer-encoding']
      res.writeHead(upstreamRes.statusCode ?? 200, {
        ...headers,
        'content-type': type ?? 'text/html; charset=utf-8',
        'content-length': String(Buffer.byteLength(injected, 'utf8')),
      })
      res.end(injected)
    })
  })
  forward.on('error', (error: Error) => {
    if (!res.headersSent) { res.writeHead(502); res.end(`proxy error: ${error.message}`) }
  })
  req.pipe(forward)
}

/** Proxy an HTTP request to the account service (path passthrough, no stripping). */
function proxyAccount(req: IncomingMessage, res: ServerResponse, accountBase: string): void {
  const forward = httpRequest(accountBase, {
    method: req.method ?? 'GET',
    path: req.url ?? '/',
    headers: req.headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
    upstreamRes.pipe(res)
  })
  forward.on('error', (error: Error) => {
    if (!res.headersSent) res.writeHead(502)
    res.end(`proxy error: ${error.message}`)
  })
  req.pipe(forward)
}

/** Proxy a WebSocket upgrade (dsh web `/api/remote.mux`) to the upstream. */
function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, upstream: Upstream): void {
  const forward = httpRequest({
    hostname: '127.0.0.1',
    port: upstream.port,
    method: 'GET',
    path: req.url ?? '/',
    headers: req.headers,
  })
  forward.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    // Forward the upstream 101 handshake verbatim so the browser receives the
    // upstream's Sec-WebSocket-Accept. Skip hop-by-hop headers Node already
    // manages (connection/upgrade would repeat on the downstream side).
    socket.write(`HTTP/1.1 ${String(upstreamRes.statusCode ?? 101)} Switching Protocols\r\n`)
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (value === undefined) continue
      const lower = key.toLowerCase()
      if (lower === 'connection' || lower === 'upgrade' || lower === 'transfer-encoding') continue
      socket.write(`${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}\r\n`)
    }
    socket.write('Upgrade: websocket\r\n')
    socket.write('Connection: Upgrade\r\n')
    socket.write('\r\n')
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    if (upstreamHead.length > 0) upstreamSocket.write(upstreamHead)
  })
  forward.on('error', () => { socket.destroy() })
  forward.end()
}

/** Find the upstream route for a path. A `''` key is the default upstream that catches every unmatched path with no prefix stripping. */
function matchRoute(
  routes: ReadonlyMap<string, Upstream>,
  pathname: string,
): { upstream: Upstream; prefix: string } | undefined {
  for (const [prefix, upstream] of routes) {
    if (prefix === '') continue
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return { upstream, prefix }
    }
  }
  const fallback = routes.get('')
  return fallback === undefined ? undefined : { upstream: fallback, prefix: '' }
}

/** Start the proxy server (static mode); returns the listening http.Server. */
export function startProxy(options: ProxyOptions): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://proxy.invalid').pathname
    const route = matchRoute(options.routes, pathname)
    if (route === undefined) {
      res.writeHead(404)
      res.end('no upstream for this path')
      return
    }
    proxyHttp(req, res, route.upstream, route.prefix)
  })

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://proxy.invalid').pathname
    const route = matchRoute(options.routes, pathname)
    if (route === undefined) {
      socket.destroy()
      return
    }
    proxyUpgrade(req, socket, head, route.upstream)
  })

  server.listen(options.port, '0.0.0.0')
  return server
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const segment of header.split(';')) {
    const eq = segment.indexOf('=')
    if (eq === -1 || segment.slice(0, eq).trim() !== name) continue
    return segment.slice(eq + 1).trim()
  }
  return undefined
}

function hasDshAuthCookie(header: string | undefined): boolean {
  if (header === undefined) return false
  return header.split(';').some(segment => segment.trim().startsWith('dsh-auth-'))
}

/**
 * Complete the dsh launch-token exchange against the instance over loopback,
 * returning the `set-cookie` header the instance issued (the browser session
 * cookie bound to the forwarded authority). The exchange is a `GET /?token=`
 * that 303s to `/` with the cookie; we never follow the redirect, only capture
 * the set-cookie.
 */
async function captureDshSessionCookie(
  port: number,
  launchToken: string,
  hostHeader: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const forward = httpRequest({
      hostname: '127.0.0.1',
      port,
      method: 'GET',
      path: `/?token=${encodeURIComponent(launchToken)}`,
      headers: { host: hostHeader },
    }, (upstreamRes) => {
      const setCookie = upstreamRes.headers['set-cookie']
      const value = Array.isArray(setCookie) ? setCookie[0] : setCookie
      upstreamRes.resume()
      resolve(value)
    })
    forward.on('error', () => { resolve(undefined) })
    forward.end()
  })
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

export interface AccountProxyOptions {
  /** Port the proxy entry listens on. */
  readonly port: number
  /** Account service base URL (e.g. http://127.0.0.1:3900). */
  readonly accountUrl: string
  /** Instance ports to prefer for a user before falling back to the account route decision. */
  readonly staticRoutes?: ReadonlyMap<string, number>
}

/**
 * The name of the dsh instance's browser-session cookie for one authority
 * (mirrors `browser-auth.ts`: `dsh-auth-` + base64url(sha256(authority))). The
 * proxy computes it from the forwarded Host so logout can clear the instance
 * session too, not only the team session.
 */
function dshAuthCookieName(authority: string): string {
  const digest = createHash('sha256').update(authority).digest()
  return 'dsh-auth-' + digest.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** The request authority used for cookie naming (host, including port). */
function requestAuthority(req: IncomingMessage): string {
  const host = req.headers.host ?? ''
  return host
}

/**
 * The fixed logout overlay injected into every served HTML page. Clicking it
 * clears both the team session and the dsh instance session, then reloads to
 * the (now unauthenticated) login page.
 */
const LOGOUT_BADGE = `<div id="dsh-team-logout" title="退出登录"
  style="position:fixed;top:12px;right:12px;z-index:2147483000;
         background:rgba(10,18,40,.72);color:#dfe7ff;border:1px solid rgba(120,160,255,.35);
         padding:6px 14px;border-radius:999px;font:12px/1.6 system-ui,sans-serif;
         cursor:pointer;user-select:none;backdrop-filter:blur(6px);">退出登录</div>
<script>
(() => {
  const el = document.getElementById('dsh-team-logout')
  if (!el) return
  el.addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST' }) } catch {}
    window.location.href = '/'
  })
})()
</script>`

/** Inject the logout overlay before the closing body tag of an HTML document. */
function injectLogoutBadge(body: string): string {
  if (body.includes('dsh-team-logout')) return body
  const idx = body.lastIndexOf('</body>')
  if (idx === -1) return body
  return body.slice(0, idx) + LOGOUT_BADGE + body.slice(idx)
}

/**
 * Complete a logout locally: forward to the account service to destroy the
 * team session (and its Redis record), then clear the dsh instance browser
 * cookie for this authority so the browser is fully signed out.
 */
function handleTeamLogout(req: IncomingMessage, res: ServerResponse, accountUrl: string): void {
  const authority = requestAuthority(req)
  const account = httpRequest(accountUrl, {
    method: 'POST',
    path: '/api/logout',
    headers: { cookie: req.headers.cookie ?? '' },
  }, (upstreamRes) => {
    const setCookies: string[] = []
    const upstream = upstreamRes.headers['set-cookie']
    if (Array.isArray(upstream)) setCookies.push(...upstream)
    else if (typeof upstream === 'string') setCookies.push(upstream)
    // Clear the dsh instance session cookie for this authority too.
    const clear = `${dshAuthCookieName(authority)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`
    setCookies.push(clear)
    upstreamRes.resume()
    if (!res.headersSent) {
      res.setHeader('set-cookie', setCookies)
      res.writeHead(302, { location: '/' })
    }
    res.end()
  })
  account.on('error', () => {
    if (!res.headersSent) {
      res.setHeader('set-cookie', `${dshAuthCookieName(authority)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`)
      res.writeHead(302, { location: '/' })
    }
    res.end()
  })
  account.end()
}

/** Account-service route decision for the current session. */
interface RouteDecision {
  authenticated: boolean
  port?: number
  /** The instance's dsh launch token (proxy-internal only, never sent to the browser). */
  launchToken?: string
}

/** Ask the account service for the session's instance port. */
async function accountRouteDecision(accountUrl: string, cookieHeader: string | undefined): Promise<RouteDecision> {
  const url = new URL('/api/session/route', accountUrl)
  const res = await fetch(url, { headers: cookieHeader === undefined ? {} : { cookie: cookieHeader } })
  if (!res.ok) return { authenticated: false }
  const body = await res.json() as { authenticated?: unknown; instance?: { port?: unknown; launchToken?: unknown } | null }
  if (body.authenticated !== true) return { authenticated: false }
  const port = body.instance?.port
  const launchToken = body.instance?.launchToken
  return {
    authenticated: true,
    port: typeof port === 'number' ? port : undefined,
    launchToken: typeof launchToken === 'string' && launchToken !== '' ? launchToken : undefined,
  }
}

/**
 * Start an account-mode proxy: public login/logout/me proxied to the account
 * service; every other path routed by the session's instance port. Unknown or
 * expired sessions receive the login page; authenticated members without a
 * spawned instance receive a "not ready" page.
 */
export function startAccountProxy(options: AccountProxyOptions): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://proxy.invalid').pathname
    // Logout is handled locally so both the team session (via the account
    // service) and this authority's dsh instance cookie are cleared.
    if (pathname === '/api/logout') {
      handleTeamLogout(req, res, options.accountUrl)
      return
    }
    // The other public account endpoints proxy straight to the account service
    // (it owns cookie issuance and login state).
    if (pathname === '/api/login' || pathname === '/api/me') {
      proxyAccount(req, res, options.accountUrl)
      return
    }
    void (async () => {
      try {
        const session = readCookie(req.headers.cookie, TEAM_SESSION_COOKIE)
        if (session === undefined) {
          // API calls without a session get JSON; browser navigation gets the page.
          if (pathname.startsWith('/api/')) { json(res, 401, { authenticated: false }); return }
          html(res, 401, LOGIN_PAGE)
          return
        }
        const decision = await accountRouteDecision(options.accountUrl, req.headers.cookie)
        if (!decision.authenticated) {
          if (pathname.startsWith('/api/')) { json(res, 401, { authenticated: false }); return }
          html(res, 401, LOGIN_PAGE)
          return
        }
        const port = decision.port
        if (port === undefined) {
          html(res, 200, NOT_READY_PAGE)
          return
        }
        // First visit for this authority: complete the dsh launch-token
        // exchange so the browser holds the instance session cookie, then
        // redirect back to the same path. The instance cookie is bound to the
        // forwarded Host, so it validates on every later proxied request.
        if (!pathname.startsWith('/api/') && !hasDshAuthCookie(req.headers.cookie) && decision.launchToken !== undefined) {
          const hostHeader = req.headers.host ?? `127.0.0.1:${String(options.port)}`
          const setCookie = await captureDshSessionCookie(port, decision.launchToken, hostHeader)
          if (setCookie !== undefined) {
            res.setHeader('set-cookie', setCookie)
            res.writeHead(302, { location: req.url ?? '/' })
            res.end()
            return
          }
        }
        proxyHtml(req, res, { user: '', port }, '')
      } catch (error) {
        if (!res.headersSent) json(res, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    })()
  })

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      try {
        const session = readCookie(req.headers.cookie, TEAM_SESSION_COOKIE)
        if (session === undefined) {
          socket.destroy()
          return
        }
        const decision = await accountRouteDecision(options.accountUrl, req.headers.cookie)
        if (!decision.authenticated || decision.port === undefined) {
          socket.destroy()
          return
        }
        proxyUpgrade(req, socket, head, { user: '', port: decision.port })
      } catch {
        socket.destroy()
      }
    })()
  })

  server.listen(options.port, '0.0.0.0')
  return server
}
