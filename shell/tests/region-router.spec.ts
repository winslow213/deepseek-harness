import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { RegionRouterFileSystem } from '../src/remote/region-router.ts'
import type { MountRecord } from '../src/remote/hub.ts'

const SHADOW_ROOT = '/tmp/dsh-shadow-test'
const USER = 'winslow'
const AGENT_ID = 'pairing@WH-D-010484A'
const SHADOW_PATH = `${SHADOW_ROOT}/${USER}/${AGENT_ID}`

/** Fake hub serving a mutable mount table over both the one-shot GET and the
 * NDJSON push stream, plus the fs POST the router calls once a shadow path
 * resolves to a mount, echoing the requested remote path back so the test
 * can see which root translation was actually used. */
function startFakeHub(): {
  server: Server
  setRoot: (root: string) => void
  pushRoot: (root: string) => void
  fsRequests: string[]
} {
  let root = ''
  const fsRequests: string[] = []
  const subscribers = new Set<ServerResponse>()
  const currentMounts = (): MountRecord[] => [{ agentId: AGENT_ID, user: USER, root, shadowPath: SHADOW_PATH }]
  const pushRoot = (next: string): void => {
    root = next
    const line = `${JSON.stringify(currentMounts())}\n`
    for (const res of subscribers) res.write(line)
  }
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/mounts') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(currentMounts()))
      return
    }
    if (req.method === 'GET' && req.url === '/api/mounts/stream') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(`${JSON.stringify(currentMounts())}\n`)
      subscribers.add(res)
      req.on('close', () => { subscribers.delete(res) })
      return
    }
    if (req.method === 'POST' && req.url === '/api/fs') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        const spec = JSON.parse(body) as { path: string }
        fsRequests.push(spec.path)
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.end(`${JSON.stringify({ type: 'fs:result', value: { targetKey: 'k' } })}\n`)
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  return {
    server,
    setRoot: (next: string) => { root = next },
    pushRoot,
    fsRequests,
  }
}

describe('RegionRouterFileSystem mount cache', () => {
  let hub: ReturnType<typeof startFakeHub>
  let url: string

  before(async () => {
    hub = startFakeHub()
    await new Promise<void>((resolve) => hub.server.listen(0, '127.0.0.1', resolve))
    const { port } = hub.server.address() as AddressInfo
    url = `http://127.0.0.1:${String(port)}`
  })
  after(async () => {
    await new Promise<void>((resolve) => hub.server.close(() => resolve()))
  })

  it('refreshes the cached mount root the moment the hub pushes a re-pair, with no polling', async () => {
    hub.setRoot('D:\\workspace')

    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: tmpdir() })
    const fiber = await ctx.plugin(RegionRouterFileSystem, {
      hubUrl: url,
      shadowRoot: SHADOW_ROOT,
      user: USER,
    })
    try {
      const fs = ctx.fs as RegionRouterFileSystem
      // Let the constructor's stream subscription land its first message.
      await new Promise((resolve) => setTimeout(resolve, 30))

      await fs.resolve(SHADOW_PATH)
      assert.equal(hub.fsRequests.at(-1), 'D:\\workspace', 'first resolve uses the root live at construction')

      // Re-pair the same agent with a deeper root — the shadow path is unchanged
      // (it is keyed by agentId, not root), so a naive "translation still
      // succeeds" cache would never refresh without the hub's push below.
      hub.pushRoot('D:\\workspace\\hap_project')
      await new Promise((resolve) => setTimeout(resolve, 30)) // let the pushed line land

      await fs.resolve(SHADOW_PATH)
      assert.equal(hub.fsRequests.at(-1), 'D:\\workspace\\hap_project', 'second resolve picks up the re-paired root as soon as the hub pushes it')
    } finally {
      await fiber.dispose()
    }
  })
})
