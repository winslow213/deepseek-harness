/**
 * Minimal reverse proxy for the team shell: aggregates per-user dsh web
 * instances behind one entry host.
 *
 * The dsh web trust model requires the Host header seen by the instance to be
 * the authority the browser authenticated against. This proxy forwards the
 * original Host header untouched, so a user who logs in at the shell entry
 * host gets cookies bound to that authority and every proxied request passes
 * the instance's Host/Origin fence.
 *
 * Each dsh web instance must be started with `--trusted-host <entry-host>` so
 * the fence accepts the non-loopback Host the proxy forwards.
 *
 * @module dsh-team-shell/reverse-proxy
 */

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

/** Start the proxy server; returns the listening http.Server. */
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
