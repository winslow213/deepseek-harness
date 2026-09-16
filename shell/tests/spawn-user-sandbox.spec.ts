/**
 * The team sandbox patch is YAML consumed by the loader at every instance
 * start, so a syntax mistake here does not degrade a feature — it stops the
 * account from booting at all. These cases pin the properties that make it
 * parse and mean what the read shield needs.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provisionUserHome } from '../src/spawn-user.ts'

describe('team sandbox patch', () => {
  async function patchFor(user: string, env: NodeJS.ProcessEnv): Promise<string> {
    const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-users-'))
    try {
      provisionUserHome(user, { ...env, DSH_USERS_ROOT: usersRoot })
      return await readFile(join(usersRoot, user, 'cordis.patch.yml'), 'utf8')
    } finally {
      await rm(usersRoot, { recursive: true, force: true })
    }
  }

  it('quotes the bracketed !!js read-shield expressions', async () => {
    const patch = await patchFor('alice', process.env)
    // An unquoted `!!js [` value parses as a YAML flow sequence, and the
    // trailing `.filter(...)` then fails the whole patch — which stops the
    // account from booting, not merely the shield from applying.
    assert.match(patch, /readDeniedRoots: !!js '\[process\.env\.DSH_USERS_ROOT\]\.filter\(Boolean\)'/)
    assert.match(patch, /readAllowedRoots: !!js '\[process\.env\.DSH_HOME\]\.filter\(Boolean\)'/)
    for (const line of patch.split('\n')) {
      if (!line.includes('!!js')) continue
      const value = line.slice(line.indexOf('!!js') + 4).trim()
      assert.ok(
        !value.startsWith('[') || value.startsWith("'") || value.startsWith('"'),
        `unquoted bracketed !!js expression would break the patch: ${line}`,
      )
    }
  })

  it('reads both shield roots from the environment, so no account path is baked in', async () => {
    const patch = await patchFor('alice', process.env)
    assert.match(patch, /readDeniedRoots: !!js .*DSH_USERS_ROOT/)
    assert.match(patch, /readAllowedRoots: !!js .*DSH_HOME/)
    // The account's own home is never spelled literally into a shared file.
    assert.doesNotMatch(patch, /readAllowedRoots: !!js .*alice/)
  })
})
