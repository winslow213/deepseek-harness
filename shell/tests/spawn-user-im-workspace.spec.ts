/**
 * `@xmanrui/dsh-im` defaults an unmapped bot's workspace to `process.cwd()`,
 * and every instance's cwd is the shared repo root — so a bot's first
 * connection on any channel silently maps it to the whole repository unless
 * `workspaces.json` already names the account's own workspace. These cases
 * pin the self-heal that rewrites that wrong default back to the account's
 * own workspace on every restart.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureImWorkspaceDefault, ensureImWorkspacePatch, provisionUserHome, userHome, userWorkspace } from '../src/spawn-user.ts'

/** The repo root the module under test resolves the wrong default from. */
const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')

describe('ensureImWorkspaceDefault', () => {
  async function integrationWorkspaces(
    usersRoot: string,
    user: string,
    integration: string,
    workspaces: Record<string, string>,
  ): Promise<string> {
    const dir = join(usersRoot, user, 'integrations', integration)
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'workspaces.json')
    await writeFile(path, JSON.stringify({ version: 2, workspaces, accessPolicies: {} }, null, 2) + '\n')
    return path
  }

  it('rewrites a bot mapped to the repo root default to the account workspace', async () => {
    const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-users-'))
    try {
      const env = { ...process.env, DSH_USERS_ROOT: usersRoot }
      const path = await integrationWorkspaces(usersRoot, 'anders', 'dsh-wechat', {
        wx_bot_1: REPO_ROOT,
      })
      ensureImWorkspaceDefault('anders', env)
      const doc = JSON.parse(await readFile(path, 'utf8'))
      assert.equal(doc.workspaces.wx_bot_1, userWorkspace('anders', env))
    } finally {
      await rm(usersRoot, { recursive: true, force: true })
    }
  })

  it('leaves an already-correct mapping and unrelated fields untouched', async () => {
    const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-users-'))
    try {
      const env = { ...process.env, DSH_USERS_ROOT: usersRoot }
      const workspace = userWorkspace('winslow', env)
      const path = await integrationWorkspaces(usersRoot, 'winslow', 'dsh-feishu', {
        bot_1: workspace,
      })
      const before = await readFile(path, 'utf8')
      ensureImWorkspaceDefault('winslow', env)
      const after = await readFile(path, 'utf8')
      assert.equal(after, before)
    } finally {
      await rm(usersRoot, { recursive: true, force: true })
    }
  })

  it('is a no-op when the account has no integrations directory', async () => {
    const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-users-'))
    try {
      const env = { ...process.env, DSH_USERS_ROOT: usersRoot }
      await mkdir(userHome('darcy', env), { recursive: true })
      assert.doesNotThrow(() => ensureImWorkspaceDefault('darcy', env))
    } finally {
      await rm(usersRoot, { recursive: true, force: true })
    }
  })
})

describe('ensureImWorkspacePatch (prevention, not just repair)', () => {
  /** Install a fake @xmanrui/dsh-im into a provisioned account's profile. */
  async function withImInstalled(usersRoot: string, user: string): Promise<void> {
    await mkdir(join(usersRoot, user, 'profiles', 'web', 'node_modules', '@xmanrui', 'dsh-im'), { recursive: true })
  }

  it('pins every channel workspace to the account workspace root', async () => {
    const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-users-'))
    try {
      const env = { ...process.env, DSH_USERS_ROOT: usersRoot }
      await withImInstalled(usersRoot, 'alice')
      ensureImWorkspacePatch('alice', env)
      const patch = await readFile(join(userHome('alice', env), 'cordis.patch.yml'), 'utf8')

      assert.match(patch, /- id: xmanrui-dsh-im/)
      // Every channel the plugin's runtime resolves a default workspace for.
      for (const channel of ['feishu', 'weixin', 'dingtalk', 'wecom', 'wecomApp', 'qq', 'slack', 'telegram', 'discord', 'whatsapp', 'imessage']) {
        assert.match(patch, new RegExp(`^    ${channel}:$`, 'm'), `missing channel ${channel}`)
      }
      // The default must come from the per-account spawn env, never a literal path.
      assert.match(patch, /workspace: !!js process\.env\.DSH_WORKSPACE_ROOT/)
      assert.equal(patch.includes('/home/winslow/.dsh-users'), false, 'a literal account path would be baked in')
      // One channel key per workspace line, and nothing else claimed.
      assert.equal((patch.match(/workspace: !!js/g) ?? []).length, 11)
    } finally {
      await rm(usersRoot, { recursive: true, force: true })
    }
  })

  it('is idempotent and preserves unrelated patch content', async () => {
    const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-users-'))
    try {
      const env = { ...process.env, DSH_USERS_ROOT: usersRoot }
      await withImInstalled(usersRoot, 'alice')
      const patchPath = join(userHome('alice', env), 'cordis.patch.yml')
      await writeFile(patchPath, '# operator row\n- id: something-else\n  disabled: true\n')

      ensureImWorkspacePatch('alice', env)
      const first = await readFile(patchPath, 'utf8')
      ensureImWorkspacePatch('alice', env)
      const second = await readFile(patchPath, 'utf8')

      assert.equal(second, first, 'a second call changed the file')
      assert.match(second, /# operator row/)
      assert.match(second, /- id: something-else/)
      // Exactly one block, not two.
      assert.equal((second.match(/dsh-team-im-workspace/g) ?? []).length, 2) // opening + closing marker
    } finally {
      await rm(usersRoot, { recursive: true, force: true })
    }
  })

  it('writes nothing when the plugin is not installed, so no patch names an absent row', async () => {
    const usersRoot = await mkdtemp(join(tmpdir(), 'dsh-users-'))
    try {
      const env = { ...process.env, DSH_USERS_ROOT: usersRoot }
      // Provision normally, then remove the plugin to model an account that
      // has not picked up the mandatory bundle yet.
      provisionUserHome('bob', env)
      await rm(join(usersRoot, 'bob', 'profiles', 'web', 'node_modules', '@xmanrui'), { recursive: true, force: true })
      await writeFile(join(userHome('bob', env), 'cordis.patch.yml'), '# untouched\n')

      ensureImWorkspacePatch('bob', env)
      const patch = await readFile(join(userHome('bob', env), 'cordis.patch.yml'), 'utf8')
      assert.equal(patch, '# untouched\n')
    } finally {
      await rm(usersRoot, { recursive: true, force: true })
    }
  })
})
