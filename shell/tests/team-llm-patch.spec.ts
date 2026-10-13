/**
 * The team LLM patch must name the plugin that actually registers the
 * `deepseek-official` provider route.
 *
 * Upstream split that plugin out of `@deepseek-ai/dsh-llm-deepseek`, which is
 * now only the shared Messages adapter library: mounting it registers no
 * provider, so every account loses its model catalog while the patch, the
 * environment, and the settings file all still look correct. The package name
 * is therefore asserted against the package's real exports rather than as a
 * string, so the next rename fails here instead of in production.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { provisionUserHome } from '../src/spawn-user.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The team patch body for one throwaway home. */
async function teamBlock(marker: string): Promise<string> {
  const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-users-llm-'))
  try {
    // Only the rendered patch blocks are under test. Pinning no mandatory
    // bundles keeps provisioning from shelling out to a registry for a
    // plugin install this test neither covers nor needs.
    provisionUserHome('alice', { ...process.env, DSH_USERS_ROOT: usersRoot, TEAM_MANDATORY_BUNDLES: '' })
    const patch = await readFile(join(usersRoot, 'alice', 'cordis.patch.yml'), 'utf8')
    return patch.slice(patch.indexOf(`# >>> ${marker}`), patch.indexOf(`# <<< ${marker}`))
  } finally {
    await rm(usersRoot, { recursive: true, force: true })
  }
}

/** The plugin package name the team patch mounts for the provider route. */
async function mountedLlmPlugin(): Promise<string> {
  const match = /^\s+name: '([^']+)'/mu.exec(await teamBlock('dsh-team-llm'))
  assert.ok(match, 'the team LLM block names a plugin')
  return match[1]
}

/** Locate a workspace package directory by its `package.json` name. */
async function packageDirOf(name: string): Promise<string> {
  const groups = await readdir(join(REPO_ROOT, 'packages'), { withFileTypes: true })
  for (const group of groups.filter(entry => entry.isDirectory())) {
    const groupPath = join(REPO_ROOT, 'packages', group.name)
    for (const child of await readdir(groupPath, { withFileTypes: true })) {
      if (!child.isDirectory()) continue
      const dir = join(groupPath, child.name)
      try {
        const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name?: string }
        if (manifest.name === name) return dir
      } catch { /* not a package directory */ }
    }
  }
  throw new Error(`no workspace package named ${name}`)
}

describe('team LLM patch', () => {
  it('mounts a package that exports a Cordis plugin', async () => {
    const plugin = await mountedLlmPlugin()
    const source = await readFile(join(await packageDirOf(plugin), 'src', 'index.ts'), 'utf8')
    assert.match(source, /export function apply/u, `${plugin} must export apply`)
    assert.match(source, /export const name/u, `${plugin} must export name`)
  })

  it('mounts the plugin that registers the deepseek-official provider', async () => {
    const plugin = await mountedLlmPlugin()
    const source = await readFile(join(await packageDirOf(plugin), 'src', 'index.ts'), 'utf8')
    // The provider id is what an account's `agent-default-model.provider`
    // names, so a plugin registering another route leaves that setting
    // unroutable.
    assert.match(source, /PROVIDER = 'deepseek-official'/u, `${plugin} must register deepseek-official`)
  })
})

describe('team model catalog', () => {
  /**
   * Upstream's own default catalog is a deployment-visible surface that has
   * shrunk between releases — 0.2.1-alpha.2 dropped the vision model accounts
   * used to have — so the team list is pinned in the patch and asserted here
   * rather than inherited.
   */
  const EXPECTED = ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']

  it('pins the models members pick from', async () => {
    const block = await teamBlock('dsh-team-llm')
    const ids = [...block.matchAll(/^\s+- id: (\S+)$/gmu)].map(match => match[1])
    assert.deepEqual(ids, EXPECTED)
  })

  it('declares image input for every vision model', async () => {
    const block = await teamBlock('dsh-team-llm')
    for (const id of ['deepseek-flash', 'deepseek-v4-flash-vision-exp']) {
      const entry = block.slice(block.indexOf(`- id: ${id}`))
      const next = entry.indexOf('- id:', 1)
      const body = next === -1 ? entry : entry.slice(0, next)
      assert.match(body, /inputModalities: \[text, image\]/u, `${id} must accept images`)
    }
  })

  it('keeps every pinned model context window a positive number', async () => {
    const block = await teamBlock('dsh-team-llm')
    const windows = [...block.matchAll(/^\s+contextWindow: (\d+)$/gmu)].map(match => Number(match[1]))
    assert.equal(windows.length, EXPECTED.length)
    for (const value of windows) assert.ok(Number.isInteger(value) && value > 0)
  })
})
