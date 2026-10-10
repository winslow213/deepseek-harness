import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
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

  it('probes a shadow-tree path with no live mount as ordinary local semantics instead of denying it', async () => {
    hub.setRoot('D:\\workspace\\hap_project\\OH_Hap')

    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: tmpdir() })
    const fiber = await ctx.plugin(RegionRouterFileSystem, {
      hubUrl: url,
      shadowRoot: SHADOW_ROOT,
      user: USER,
      workspaceRoot: tmpdir(),
    })
    try {
      const fs = ctx.fs as RegionRouterFileSystem
      await new Promise((resolve) => setTimeout(resolve, 30))

      // A parent of the mounted shadow path (e.g. the user-level shadow
      // directory) has no matching mount: an upward walk from cwd looking for
      // a marker file (a git-root search is the common case) must see this as
      // an ordinary miss, not a hard FS_PERMISSION_DENIED that fails the turn.
      const parentPath = `${SHADOW_ROOT}/${USER}/.git`
      const target = await fs.resolve(parentPath)
      const info = await fs.stat(target)
      assert.equal(info, undefined, 'a nonexistent path outside any live mount reads as a plain miss, not a permission error')
    } finally {
      await fiber.dispose()
    }
  })

  it('rejects a write under the shadow tree with no live mount instead of writing it to local disk', async () => {
    hub.setRoot('D:\\workspace\\hap_project\\OH_Hap')

    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: tmpdir() })
    const fiber = await ctx.plugin(RegionRouterFileSystem, {
      hubUrl: url,
      shadowRoot: SHADOW_ROOT,
      user: USER,
      workspaceRoot: tmpdir(),
    })
    try {
      const fs = ctx.fs as RegionRouterFileSystem
      await new Promise((resolve) => setTimeout(resolve, 30))

      // Under the shadow root but not a live mount (a stale directory from an
      // earlier pairing, or a sibling agent id this hub doesn't report).
      const unmatchedPath = `${SHADOW_ROOT}/${USER}/some-other-agent/file.txt`
      const target = await fs.resolve(unmatchedPath)
      await assert.rejects(
        () => fs.writeText(target, 'hello'),
        (error: unknown) => error instanceof FsError && error.code === 'FS_IO_ERROR',
        'a shadow-tree write with no live mount must fail loudly, not silently create a local file',
      )
      await assert.rejects(() => stat(unmatchedPath), 'must not have created anything on local disk')
    } finally {
      await fiber.dispose()
    }
  })
})

/** A temp tree: `shared` is the grant candidate, `other` the ungranted sibling. */
function makeTree(): { base: string; workspace: string; shared: string; other: string; dispose: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'dsh-rr-read-'))
  const workspace = join(base, 'workspace')
  const shared = join(base, 'shared')
  const other = join(base, 'other')
  for (const dir of [workspace, shared, other]) mkdirSync(dir)
  writeFileSync(join(shared, 'note.txt'), 'shared\n')
  writeFileSync(join(other, 'secret.txt'), 'secret\n')
  return { base, workspace, shared, other, dispose: () => { rmSync(base, { recursive: true, force: true }) } }
}

describe('RegionRouterFileSystem local read boundary', () => {
  let hub: ReturnType<typeof startFakeHub>
  let url: string
  let tree: ReturnType<typeof makeTree>

  before(async () => {
    hub = startFakeHub()
    hub.setRoot('/remote/root')
    await new Promise<void>((resolve) => hub.server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${String((hub.server.address() as AddressInfo).port)}`
    tree = makeTree()
  })
  after(async () => {
    tree.dispose()
    await new Promise<void>((resolve) => hub.server.close(() => resolve()))
  })

  /** Mount a router over the shared tree, optionally granting `readableRoots`. */
  async function mounted(readableRoots?: readonly string[]) {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: tree.workspace })
    const fiber = await ctx.plugin(RegionRouterFileSystem, {
      hubUrl: url,
      shadowRoot: SHADOW_ROOT,
      user: USER,
      workspaceRoot: tree.workspace,
      ...readableRoots === undefined ? {} : { readableRoots },
    })
    return { fs: ctx.fs as RegionRouterFileSystem, dispose: () => fiber.dispose() }
  }

  it('reads inside the workspace without any grant', async () => {
    const m = await mounted()
    try {
      writeFileSync(join(tree.workspace, 'own.txt'), 'own\n')
      const target = await m.fs.resolve(join(tree.workspace, 'own.txt'))
      assert.equal(await m.fs.readText(target), 'own\n')
    } finally {
      await m.dispose()
    }
  })

  it('denies a local path outside the workspace when nothing grants it', async () => {
    const m = await mounted()
    try {
      const target = await m.fs.resolve(join(tree.shared, 'note.txt'))
      await assert.rejects(
        () => m.fs.readText(target),
        (error: unknown) => error instanceof FsError && error.code === 'FS_PERMISSION_DENIED',
        'the workspace root is the whole boundary until a grant widens it',
      )
    } finally {
      await m.dispose()
    }
  })

  it('reads a granted shared root that sits outside the workspace', async () => {
    const m = await mounted([tree.shared])
    try {
      const target = await m.fs.resolve(join(tree.shared, 'note.txt'))
      assert.equal(await m.fs.readText(target), 'shared\n')
    } finally {
      await m.dispose()
    }
  })

  it('still denies an ungranted sibling when a grant is present', async () => {
    const m = await mounted([tree.shared])
    try {
      const target = await m.fs.resolve(join(tree.other, 'secret.txt'))
      await assert.rejects(
        () => m.fs.readText(target),
        (error: unknown) => error instanceof FsError && error.code === 'FS_PERMISSION_DENIED',
        'granting one root must not widen the boundary to its siblings',
      )
    } finally {
      await m.dispose()
    }
  })

  it('applies the same grant to the path-based lstat gate', async () => {
    const granted = await mounted([tree.shared])
    try {
      const info = await granted.fs.lstat(join(tree.shared, 'note.txt'))
      assert.equal(info?.type, 'file')
      await assert.rejects(
        () => granted.fs.lstat(join(tree.other, 'secret.txt')),
        (error: unknown) => error instanceof FsError && error.code === 'FS_PERMISSION_DENIED',
      )
    } finally {
      await granted.dispose()
    }
  })

  it('does not treat a sibling with a shared prefix as inside the grant', async () => {
    const m = await mounted([tree.shared])
    try {
      const lookalike = `${tree.shared}-elsewhere`
      mkdirSync(lookalike)
      try {
        const target = await m.fs.resolve(join(lookalike, 'x.txt'))
        await assert.rejects(
          () => m.fs.readText(target),
          (error: unknown) => error instanceof FsError && error.code === 'FS_PERMISSION_DENIED',
          'containment is compared on path segments, not raw prefixes',
        )
      } finally {
        rmSync(lookalike, { recursive: true, force: true })
      }
    } finally {
      await m.dispose()
    }
  })

  it('keeps the read-anywhere bare form when no workspaceRoot is configured', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: tmpdir() })
    const fiber = await ctx.plugin(RegionRouterFileSystem, { hubUrl: url, shadowRoot: SHADOW_ROOT, user: USER })
    try {
      const bare = ctx.fs as RegionRouterFileSystem
      const target = await bare.resolve(join(tree.other, 'secret.txt'))
      assert.equal(await bare.readText(target), 'secret\n', 'the bare form still reads anywhere')
    } finally {
      await fiber.dispose()
    }
  })
})
