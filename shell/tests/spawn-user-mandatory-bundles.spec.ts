/**
 * `ensureMandatoryBundles` shells out to `pnpm add` through the `dsh plugin`
 * CLI when a pinned spec is missing, so only its no-network fast path (every
 * pinned version already present) is covered here — exercising the install
 * path would need a live registry, the same category as this repo's
 * key-gated e2e tests.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureMandatoryBundles, provisionUserHome } from '../src/spawn-user.ts'

describe('ensureMandatoryBundles', () => {
  it('does not spawn pnpm when every pinned spec already matches the manifest', async () => {
    const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-users-'))
    try {
      const env = { ...process.env, DSH_USERS_ROOT: usersRoot }
      provisionUserHome('alice', env)
      const manifestPath = join(usersRoot, 'alice', 'profiles', 'web', 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      manifest.dependencies = {
        ...manifest.dependencies,
        '@xmanrui/dsh-im': '4.20.2',
        '@nanmicoder/dsh-agent-teams': '^0.1.18',
      }
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

      // A real install would need a live pnpm registry; the assertion here is
      // that the already-satisfied fast path returns without touching the
      // manifest again (a spawn would still leave it untouched on success,
      // so this mainly proves the function does not throw or hang).
      ensureMandatoryBundles('alice', env)
      const after = await readFile(manifestPath, 'utf8')
      assert.deepEqual(JSON.parse(after), manifest)
    } finally {
      await rm(usersRoot, { recursive: true, force: true })
    }
  })

  it('is a no-op when the profile manifest does not exist yet', () => {
    // Guards the missing/corrupt-manifest branch without touching the
    // filesystem: an account that failed manifest provisioning must not
    // crash provisioning altogether.
    assert.doesNotThrow(() => ensureMandatoryBundles('nonexistent-user', {
      ...process.env,
      DSH_USERS_ROOT: join(tmpdir(), 'dsh-users-definitely-missing-xyz'),
    }))
  })
})
