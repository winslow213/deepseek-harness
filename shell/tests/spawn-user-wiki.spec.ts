import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureUserWiki } from '../src/spawn-user.ts'
import { wikiPluginsDirFor } from '../src/remote/inject.ts'
import { wikiPaths, writeWikiLayer } from '../src/remote/wiki-fs.ts'

describe('ensureUserWiki', () => {
  it('scaffolds the wiki files, copies the tool runtime, and patches the home layer', async () => {
    const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-users-'))
    try {
      const env = { ...process.env, DSH_USERS_ROOT: usersRoot }
      ensureUserWiki('alice', env)

      const home = join(usersRoot, 'alice')
      const workspace = join(home, 'workspace')
      assert.ok(existsSync(wikiPaths(workspace).identity))
      assert.ok(existsSync(wikiPaths(workspace).preferences))
      assert.ok(existsSync(wikiPaths(workspace).timeline))
      assert.ok(existsSync(wikiPaths(workspace).decisions))

      const pluginsDir = wikiPluginsDirFor(home)
      assert.ok(existsSync(join(pluginsDir, 'wiki-tool.ts')))
      assert.ok(existsSync(join(pluginsDir, 'wiki-fs.ts')))

      const patch = await readFile(join(home, 'cordis.patch.yml'), 'utf8')
      assert.match(patch, /id: tool-wiki/)
      assert.match(patch, /id: agent-instructions/)
      assert.match(patch, /\.dsh-wiki-identity\.md/)
      assert.match(patch, /\.dsh-wiki-preferences\.md/)
      assert.match(patch, new RegExp(workspace.replace(/[/\\]/g, '\\$&')))
    } finally {
      await rm(usersRoot, { recursive: true, force: true })
    }
  })

  it('is idempotent: a second call never overwrites existing wiki content or unrelated patch blocks', async () => {
    const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-users-'))
    try {
      const env = { ...process.env, DSH_USERS_ROOT: usersRoot }
      ensureUserWiki('bob', env)
      const home = join(usersRoot, 'bob')
      const workspace = join(home, 'workspace')
      writeWikiLayer(workspace, 'identity', { title: '', content: 'bob is a backend engineer' })
      await writeFile(join(home, 'cordis.patch.yml'), `# operator note\n${await readFile(join(home, 'cordis.patch.yml'), 'utf8')}`)

      ensureUserWiki('bob', env)

      const identity = await readFile(wikiPaths(workspace).identity, 'utf8')
      assert.equal(identity, 'bob is a backend engineer\n')
      const patch = await readFile(join(home, 'cordis.patch.yml'), 'utf8')
      assert.match(patch, /# operator note/)
    } finally {
      await rm(usersRoot, { recursive: true, force: true })
    }
  })
})
