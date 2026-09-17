/**
 * Provisioning acceptance for the wiki v2 mechanism (spec §10 S6): a
 * brand-new account must come up with the four layers, the op log, a seeded
 * baseline, and a working fail-safe — automatically, with no operator step
 * and no separate migration path for existing accounts.
 *
 * This is the acceptance run for the slice rather than more unit coverage:
 * every other spec drives one module directly, while this one goes through
 * `provisionUserHome` exactly as account creation does.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provisionUserHome, userHome, userWorkspace } from '../src/spawn-user.ts'
import { WIKI_RUNTIME_FILES, wikiPluginsDirFor } from '../src/remote/inject.ts'
import { assertMergeBaseline, oplogPaths, pendingWeight, readOps, readWatermark } from '../src/remote/oplog.ts'
import { wikiPaths } from '../src/remote/wiki-fs.ts'

describe('S6: a new account provisions the whole wiki v2 mechanism', () => {
  it('creates the four layers, the op log, and a passing fail-safe in one provisioning call', async () => {
    const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-s6-'))
    try {
      const env = { ...process.env, DSH_USERS_ROOT: usersRoot }
      provisionUserHome('newbie', env)
      const workspace = userWorkspace('newbie', env)
      const paths = wikiPaths(workspace)

      // The four layers, with the auto-injected two in the workspace root.
      for (const file of [paths.identity, paths.preferences, paths.timeline, paths.decisions]) {
        assert.ok(existsSync(file), `missing wiki layer ${file}`)
      }

      // The op log exists and carries a baseline per non-empty layer, so the
      // profile is rebuildable and the fail-safe below has something to see.
      const ops = readOps(workspace)
      assert.ok(ops.length > 0, 'provisioning did not seed the op log')
      assert.ok(ops.every(op => op.op === 'baseline'))
      assert.ok(ops.every(op => op.by === 'provisioning'))

      const watermark = readWatermark(workspace)
      assert.notEqual(watermark, undefined)
      assert.equal(watermark?.offset, statSync(oplogPaths(workspace).opsPath).size)
      assert.equal(watermark?.archiveEpoch.file, null)

      // The acceptance criterion that motivated the slice: a brand-new account
      // used to be blocked here forever, because scaffolded skeleton text is
      // non-empty while the op log did not exist yet.
      assert.doesNotThrow(() => assertMergeBaseline(workspace, true))
      assert.equal(pendingWeight(workspace).state, 'idle')
    } finally {
      await rm(usersRoot, { recursive: true, force: true })
    }
  })

  it('copies every runtime module the wiki plugin needs, so the instance can boot it', async () => {
    const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-s6-'))
    try {
      const env = { ...process.env, DSH_USERS_ROOT: usersRoot }
      provisionUserHome('newbie', env)
      const pluginsDir = wikiPluginsDirFor(userHome('newbie', env))
      const copied = await readdir(pluginsDir)
      for (const file of WIKI_RUNTIME_FILES) {
        assert.ok(copied.includes(file), `wiki plugin runtime is missing ${file}; the instance would fail to load`)
      }
      // Content, not just presence: an empty or truncated copy is not loadable.
      for (const file of WIKI_RUNTIME_FILES) {
        const text = await readFile(join(pluginsDir, file), 'utf8')
        assert.ok(text.length > 0, `copied ${file} is empty`)
      }
    } finally {
      await rm(usersRoot, { recursive: true, force: true })
    }
  })

  it('is idempotent across restarts: provisioning again does not re-baseline or duplicate anything', async () => {
    const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-s6-'))
    try {
      const env = { ...process.env, DSH_USERS_ROOT: usersRoot }
      provisionUserHome('newbie', env)
      const workspace = userWorkspace('newbie', env)
      const before = readOps(workspace).length
      const offsetBefore = readWatermark(workspace)?.offset

      provisionUserHome('newbie', env)
      provisionUserHome('newbie', env)

      // Every restart runs provisioning; none may append a second history.
      assert.equal(readOps(workspace).length, before)
      assert.equal(readWatermark(workspace)?.offset, offsetBefore)
    } finally {
      await rm(usersRoot, { recursive: true, force: true })
    }
  })

  it('applies the same path to an account whose profile predates the op log', async () => {
    const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-s6-'))
    try {
      const env = { ...process.env, DSH_USERS_ROOT: usersRoot }
      // Simulate the pre-v2 shape: real accumulated content, no oplog at all.
      const workspace = userWorkspace('legacy-user', env)
      await mkdir(workspace, { recursive: true })
      const realIdentity = '# identity\n\n## established\n\nreal accumulated history\n'
      await writeFile(wikiPaths(workspace).identity, realIdentity)
      await writeFile(wikiPaths(workspace).preferences, '# preferences\n\n## habits\n\nreal\n')

      provisionUserHome('legacy-user', env)

      // One path, not a migration script: the same provisioning run seeds it.
      const identityBaseline = readOps(workspace).find(op => op.layer === 'identity')
      assert.equal(identityBaseline?.text, realIdentity, 'the seeded baseline must reproduce the real content')
      assert.doesNotThrow(() => assertMergeBaseline(workspace, true))
    } finally {
      await rm(usersRoot, { recursive: true, force: true })
    }
  })
})
