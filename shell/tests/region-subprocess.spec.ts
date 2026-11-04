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
const SECOND_AGENT = 'pairing@second-device'
const SECOND_DEVICE_ROOT = '/tmp/device-workspace-two'
const SECOND_SHADOW_CWD = `${SHADOW_ROOT}/${USER}/pairing@second-device`

/**
 * A hub stub that serves the mount table, the agent list, and records `/api/pty`
 * bodies. The device reports a Windows shell world so a terminal opened there
 * must be described by the device rather than by this server.
 */
async function startFakeHub(): Promise<{ url: string; ptyRequests: string[]; server: Server }> {
  const ptyRequests: string[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
    req.on('end', () => {
      if (req.url === '/api/agents') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([
          { agentId: 'pairing@host', user: USER, remote: '10.0.0.9:1', roots: [DEVICE_ROOT],
            commands: ['bash'], platform: 'windows', defaultShell: 'C:\\Windows\\system32\\cmd.exe',
            connectedAt: 1, lastSeen: 1 },
          { agentId: SECOND_AGENT, user: USER, remote: '10.0.0.9:2', roots: [SECOND_DEVICE_ROOT],
            commands: ['bash'], platform: 'posix', defaultShell: '/bin/dash',
            connectedAt: 1, lastSeen: 1 },
        ]))
        return
      }
      if (req.url === '/api/mounts') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([
          { agentId: 'pairing@host', user: USER, root: DEVICE_ROOT, shadowPath: SHADOW_CWD },
          { agentId: SECOND_AGENT, user: USER, root: SECOND_DEVICE_ROOT, shadowPath: SECOND_SHADOW_CWD },
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
      const body = JSON.parse(hub.ptyRequests[0] ?? '{}') as { user?: string; cwd?: string; agentId?: string }
      // The agent validates cwd against the roots it serves, so forwarding the
      // shadow path would be rejected there — it names a directory only the
      // server has.
      assert.equal(body.cwd, DEVICE_CWD, 'the device receives its own real workspace path')
      assert.equal(body.user, USER, 'the hub addresses agents by owner')
      // A user may pair several devices, so the owner alone does not name the
      // machine the workspace lives on; the hub refuses to guess between them.
      assert.equal(body.agentId, 'pairing@host', 'the allocation names the agent serving that mount')
    } finally {
      await fiber.dispose()
      await new Promise<void>((resolve) => { hub.server.close(() => { resolve() }) })
    }
  })

  it('addresses the agent that serves the shadow being opened', async () => {
    const hub = await startFakeHub()
    const { ctx, fiber } = await mount(hub.url)
    try {
      await assert.rejects(
        (ctx as unknown as { subprocess: RegionRouterSubprocessRuntime }).subprocess
          .spawnTerminal({ argv: ['bash'], cwd: SECOND_SHADOW_CWD, ...TERMINAL }),
        (error: unknown) => error instanceof RemotePtyError && /agent offline/u.test(error.message),
      )
      assert.equal(hub.ptyRequests.length, 1, 'exactly one allocation reached the hub')
      const body = JSON.parse(hub.ptyRequests[0] ?? '{}') as { cwd?: string; agentId?: string }
      assert.equal(body.agentId, SECOND_AGENT, 'the allocation follows the mount, not the first paired device')
      assert.equal(body.cwd, SECOND_DEVICE_ROOT, 'the second device receives its own real workspace path')
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

  it('describes a mounted terminal with the device shell world', async () => {
    const hub = await startFakeHub()
    const { ctx, fiber } = await mount(hub.url)
    try {
      const runtime = (ctx as unknown as { subprocess: RegionRouterSubprocessRuntime }).subprocess
      // The server resolves shells for itself, so answering from the local
      // provider would name a path the Windows device cannot run.
      const environment = await runtime.terminalEnvironment(undefined, SHADOW_CWD)
      assert.deepEqual(environment, {
        platform: 'windows',
        defaultShell: 'C:\\Windows\\system32\\cmd.exe',
      })
    } finally {
      await fiber.dispose()
      await new Promise<void>((resolve) => { hub.server.close(() => { resolve() }) })
    }
  })

  it('resolves a mounted shell name on the device instead of the server', async () => {
    const hub = await startFakeHub()
    const { ctx, fiber } = await mount(hub.url)
    try {
      const runtime = (ctx as unknown as { subprocess: RegionRouterSubprocessRuntime }).subprocess
      // A server-side resolution would return an absolute server path such as
      // /usr/bin/bash, which names nothing on the paired machine.
      assert.equal(await runtime.resolveExecutable('bash', undefined, undefined, SHADOW_CWD), 'bash')
    } finally {
      await fiber.dispose()
      await new Promise<void>((resolve) => { hub.server.close(() => { resolve() }) })
    }
  })

  it('keeps local shell discovery for a workspace outside the mount tree', async () => {
    const hub = await startFakeHub()
    const { ctx, fiber } = await mount(hub.url)
    try {
      const runtime = (ctx as unknown as { subprocess: RegionRouterSubprocessRuntime }).subprocess
      const environment = await runtime.terminalEnvironment(undefined, '/tmp/not-a-mount')
      assert.equal(environment.platform, process.platform === 'win32' ? 'windows' : 'posix')
    } finally {
      await fiber.dispose()
      await new Promise<void>((resolve) => { hub.server.close(() => { resolve() }) })
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
