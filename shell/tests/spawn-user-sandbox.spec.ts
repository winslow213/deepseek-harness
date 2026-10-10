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
import { provisionUserHome, teamChildEnv } from '../src/spawn-user.ts'

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
    assert.match(patch, /readAllowedRoots: !!js JSON\.parse\(process\.env\.DSH_READ_ALLOWED_ROOTS \?\? '\[\]'\)/)
    for (const line of patch.split('\n')) {
      if (!line.includes('!!js')) continue
      const value = line.slice(line.indexOf('!!js') + 4).trim()
      assert.ok(
        !value.startsWith('[') || value.startsWith("'") || value.startsWith('"'),
        `unquoted bracketed !!js expression would break the patch: ${line}`,
      )
    }
  })

  it('reads every shield and grant root from the environment, so no account path is baked in', async () => {
    const patch = await patchFor('alice', process.env)
    assert.match(patch, /readDeniedRoots: !!js .*DSH_USERS_ROOT/)
    assert.match(patch, /readAllowedRoots: !!js .*DSH_READ_ALLOWED_ROOTS/)
    assert.match(patch, /rwRoots: !!js .*DSH_RW_ROOTS/)
    // The account's own home and its shared directories are never spelled
    // literally into a file that every account's loader reads.
    assert.doesNotMatch(patch, /readAllowedRoots: !!js .*alice/)
  })
})

describe('the role-scoped shared roots a spawn hands the child', () => {
  const USERS_ROOT = '/home/team/.dsh-users'
  const mapping = JSON.stringify([
    { path: '<usersRoot>/shared/common', roles: ['operator', 'member'] },
    { path: '<usersRoot>/shared/admin', roles: ['operator'] },
  ])

  it('passes nothing when the deployment configures no mapping', () => {
    const env = teamChildEnv(`${USERS_ROOT}/alice`, false, 'operator', { DSH_USERS_ROOT: USERS_ROOT })
    assert.equal(env.DSH_RW_ROOTS, '[]')
    assert.deepEqual(JSON.parse(env.DSH_READ_ALLOWED_ROOTS ?? '[]'), [`${USERS_ROOT}/alice`])
  })

  it('re-exposes only the account home for a role no entry grants', () => {
    const env = teamChildEnv(`${USERS_ROOT}/alice`, false, 'member', {
      DSH_USERS_ROOT: USERS_ROOT,
      TEAM_SHARED_ROOTS: JSON.stringify([{ path: '<usersRoot>/shared/admin', roles: ['operator'] }]),
    })
    assert.equal(env.DSH_RW_ROOTS, '[]')
    assert.deepEqual(JSON.parse(env.DSH_READ_ALLOWED_ROOTS ?? '[]'), [`${USERS_ROOT}/alice`])
  })

  it('gives an operator both shared directories, writable and readable', () => {
    const env = teamChildEnv(`${USERS_ROOT}/alice`, false, 'operator', {
      DSH_USERS_ROOT: USERS_ROOT,
      TEAM_SHARED_ROOTS: mapping,
    })
    const writable = [`${USERS_ROOT}/shared/common`, `${USERS_ROOT}/shared/admin`]
    assert.deepEqual(JSON.parse(env.DSH_RW_ROOTS ?? '[]'), writable)
    assert.deepEqual(JSON.parse(env.DSH_READ_ALLOWED_ROOTS ?? '[]'), [`${USERS_ROOT}/alice`, ...writable])
  })

  it('withholds the administrator directory from a member', () => {
    const env = teamChildEnv(`${USERS_ROOT}/bob`, false, 'member', {
      DSH_USERS_ROOT: USERS_ROOT,
      TEAM_SHARED_ROOTS: mapping,
    })
    assert.deepEqual(JSON.parse(env.DSH_RW_ROOTS ?? '[]'), [`${USERS_ROOT}/shared/common`])
    assert.deepEqual(JSON.parse(env.DSH_READ_ALLOWED_ROOTS ?? '[]'), [
      `${USERS_ROOT}/bob`,
      `${USERS_ROOT}/shared/common`,
    ])
  })

  it('drops a mapping the deployment spelled wrong instead of failing the spawn', () => {
    for (const broken of ['{not json', '"str"', '[{"path":7}]']) {
      const env = teamChildEnv(`${USERS_ROOT}/bob`, false, 'member', {
        DSH_USERS_ROOT: USERS_ROOT,
        TEAM_SHARED_ROOTS: broken,
      })
      assert.equal(env.DSH_RW_ROOTS, '[]')
      assert.deepEqual(JSON.parse(env.DSH_READ_ALLOWED_ROOTS ?? '[]'), [`${USERS_ROOT}/bob`])
    }
  })

  it('drops a grant that would sit over the shadow root, keeping sibling accounts hidden', () => {
    const env = teamChildEnv(`${USERS_ROOT}/bob`, false, 'member', {
      DSH_USERS_ROOT: USERS_ROOT,
      DSH_SHADOW_ROOT: '/tmp/dsh-shadow',
      TEAM_SHARED_ROOTS: JSON.stringify([{ path: '/tmp' }, { path: '<usersRoot>/shared/common' }]),
    })
    assert.deepEqual(JSON.parse(env.DSH_RW_ROOTS ?? '[]'), [`${USERS_ROOT}/shared/common`])
  })
})
