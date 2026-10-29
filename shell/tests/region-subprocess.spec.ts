/**
 * The region subprocess provider routes terminal allocation by execution world:
 * a Session whose workspace is a mount's shadow path gets the paired device's
 * shell, and everything else keeps the local provider's PTY. A fake hub records
 * which allocations it was asked for, so a routing regression shows up as a
 * terminal on the wrong machine rather than as an assertion about internals.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { RemotePtyError } from '../src/remote/pty-client.ts'
import RegionRouterSubprocessRuntime from '../src/remote/region-subprocess.ts'

const SHADOW_ROOT = '/tmp/dsh-shadow-subprocess-test'
const USER = 'winslow'
const SHADOW_CWD = `${SHADOW_ROOT}/${USER}/pairing@host`
const DEVICE_ROOT = '/tmp/device-workspace'
const DEVICE_CWD = DEVICE_ROOT
const OTHER_SHADOW_CWD = `${SHADOW_ROOT}/someone-else/pairing@host`

/** A hub stub that serves the mount table and records `/api/pty` bodies. */
async function startFakeHub(): Promise<{ url: string; ptyRequests: string[]; server: Server }> {
  const ptyRequests: string[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
    req.on('end', () => {
      if (req.url === '/api/mounts') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([
          { agentId: 'pairing@host', user: USER, root: DEVICE_ROOT, shadowPath: SHADOW_CWD },
          { agentId: 'pairing@host', user: 'someone-else', root: '/tmp/their-workspace', shadowPath: OTHER_SHADOW_CWD },
        ]))
        return
      }
      if (req.url === '/api/pty') {
        ptyRequests.push(raw)
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'agent offline' }))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, ptyRequests, server }
}

/** Mount the router over `hubUrl` on a fresh Cordis context. */
async function mount(hubUrl: string, config: { readonly user?: string } = {}): Promise<{ ctx: Context; fiber: { dispose: () => Promise<void> } }> {
  const ctx = new Context()
  const fiber = await ctx.plugin(RegionRouterSubprocessRuntime, {
    hubUrl,
    shadowRoot: SHADOW_ROOT,
    user: config.user ?? USER,
  })
  return { ctx, fiber }
}

const TERMINAL = { cols: 80, rows: 24, terminalType: 'xterm-256color' } as const

describe('RegionRouterSubprocessRuntime', () => {
  it('allocates a shadow-path terminal in the device real directory', async () => {
    const hub = await startFakeHub()
    const { ctx, fiber } = await mount(hub.url)
    try {
      await assert.rejects(
        // The cwd need not exist locally: the request is addressed to the device.
        (ctx as unknown as { subprocess: RegionRouterSubprocessRuntime }).subprocess
          .spawnTerminal({ argv: ['bash'], cwd: SHADOW_CWD, ...TERMINAL }),
        (error: unknown) => error instanceof RemotePtyError && /agent offline/u.test(error.message),
      )
      assert.equal(hub.ptyRequests.length, 1, 'exactly one allocation reached the hub')
      const body = JSON.parse(hub.ptyRequests[0] ?? '{}') as { user?: string; cwd?: string }
      // The agent validates cwd against the roots it serves, so forwarding the
      // shadow path would be rejected there — it names a directory only the
      // server has.
      assert.equal(body.cwd, DEVICE_CWD, 'the device receives its own real workspace path')
      assert.equal(body.user, USER, 'the hub addresses agents by owner')
    } finally {
      await fiber.dispose()
      await new Promise<void>((resolve) => { hub.server.close(() => { resolve() }) })
    }
  })

  it('refuses a shadow path no mount of this user covers', async () => {
    const hub = await startFakeHub()
    const { ctx, fiber } = await mount(hub.url)
    try {
      // Falling through to the local provider would run the other account's
      // device directory on this server.
      await assert.rejects(
        (ctx as unknown as { subprocess: RegionRouterSubprocessRuntime }).subprocess
          .spawnTerminal({ argv: ['bash'], cwd: OTHER_SHADOW_CWD, ...TERMINAL }),
        /no paired device serves/u,
      )
      assert.deepEqual(hub.ptyRequests, [], 'an unserved shadow path must not reach the device')
    } finally {
      await fiber.dispose()
      await new Promise<void>((resolve) => { hub.server.close(() => { resolve() }) })
    }
  })

  it('keeps a terminal outside the mount tree local', async () => {
    const hub = await startFakeHub()
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-local-terminal-'))
    const { ctx, fiber } = await mount(hub.url)
    try {
      const terminal = await (ctx as unknown as { subprocess: RegionRouterSubprocessRuntime }).subprocess
        .spawnTerminal({ argv: ['bash', '--noprofile', '--norc', '-i'], cwd: workspace, ...TERMINAL })
      try {
        assert.ok(terminal.pid > 0, 'the local provider allocated a process')
        assert.deepEqual(hub.ptyRequests, [], 'a server workspace must never reach the paired device')
      } finally {
        await terminal.terminate()
      }
    } finally {
      await fiber.dispose()
      await new Promise<void>((resolve) => { hub.server.close(() => { resolve() }) })
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('refuses to load without the user the hub addresses by', async () => {
    const hub = await startFakeHub()
    try {
      await assert.rejects(
        mount(hub.url, { user: '' }),
        /region-subprocess: user is required/u,
        'a router with no owner cannot address any agent',
      )
    } finally {
      await new Promise<void>((resolve) => { hub.server.close(() => { resolve() }) })
    }
  })
})
