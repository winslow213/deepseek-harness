import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureKbSearch } from '../src/spawn-user.ts'
import { kbSearchPluginsDirFor } from '../src/remote/inject.ts'

describe('ensureKbSearch', () => {
  it('copies the tool runtime and patches the home layer with the KB base URL and account id', async () => {
    const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-users-'))
    try {
      const env = { ...process.env, DSH_USERS_ROOT: usersRoot, TEAM_KB_BASE_URL: 'http://127.0.0.1:8080' }
      ensureKbSearch('alice', env)

      const home = join(usersRoot, 'alice')
      const pluginsDir = kbSearchPluginsDirFor(home)
      assert.ok(existsSync(join(pluginsDir, 'kb-tool.ts')))

      const patch = await readFile(join(home, 'cordis.patch.yml'), 'utf8')
      assert.match(patch, /id: tool-kb-search/)
      assert.match(patch, /userId: "alice"/)
      assert.match(patch, /kbBaseUrl: "http:\/\/127\.0\.0\.1:8080"/)
    } finally {
      await rm(usersRoot, { recursive: true, force: true })
    }
  })

  it('defaults the KB base URL to the local loopback when unset', async () => {
    const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-users-'))
    try {
      const env = { ...process.env, DSH_USERS_ROOT: usersRoot }
      delete env.TEAM_KB_BASE_URL
      ensureKbSearch('carol', env)

      const patch = await readFile(join(usersRoot, 'carol', 'cordis.patch.yml'), 'utf8')
      assert.match(patch, /kbBaseUrl: "http:\/\/127\.0\.0\.1:8080"/)
    } finally {
      await rm(usersRoot, { recursive: true, force: true })
    }
  })

  it('is idempotent: a second call never clobbers unrelated patch blocks', async () => {
    const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-users-'))
    try {
      const env = { ...process.env, DSH_USERS_ROOT: usersRoot }
      ensureKbSearch('bob', env)
      const home = join(usersRoot, 'bob')
      await writeFile(join(home, 'cordis.patch.yml'), `# operator note\n${await readFile(join(home, 'cordis.patch.yml'), 'utf8')}`)

      ensureKbSearch('bob', env)

      const patch = await readFile(join(home, 'cordis.patch.yml'), 'utf8')
      assert.match(patch, /# operator note/)
      assert.match(patch, /id: tool-kb-search/)
    } finally {
      await rm(usersRoot, { recursive: true, force: true })
    }
  })
})
