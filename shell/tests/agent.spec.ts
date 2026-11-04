import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAllowedCommand, resolveLstatTarget } from '../src/remote/agent.ts'

describe('resolveLstatTarget', () => {
  it('lstats an allowlisted root itself instead of failing on its unreachable parent', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agent-lstat-')))
    try {
      const target = await resolveLstatTarget(root, [root])
      assert.equal(target, root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the final component literal (not realpath-followed) for a nested symlink', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agent-lstat-')))
    try {
      const real = join(root, 'real')
      await mkdir(real)
      const link = join(root, 'link')
      await symlink(real, link)

      const target = await resolveLstatTarget(link, [root])
      assert.equal(target, link)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still rejects a path genuinely outside every allowlisted root', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agent-lstat-')))
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agent-lstat-outside-')))
    try {
      await assert.rejects(
        () => resolveLstatTarget(outside, [root]),
        /path outside allowed roots/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('isAllowedCommand', () => {
  it('grants the exact basename on every platform', () => {
    assert.equal(isAllowedCommand(new Set(['bash']), 'bash', 'linux'), true)
    assert.equal(isAllowedCommand(new Set(['cmd']), 'cmd', 'win32'), true)
  })

  it('refuses a program the operator did not permit', () => {
    assert.equal(isAllowedCommand(new Set(['bash']), 'cat', 'linux'), false)
    assert.equal(isAllowedCommand(new Set(['cmd']), 'powershell.exe', 'win32'), false)
  })

  it('treats a Windows program name and its .exe form as one grant', () => {
    // `basename('C:\\Windows\\system32\\cmd.exe')` is `cmd.exe` while the
    // operator allowlisted `cmd`; Windows resolves both to the same file, so a
    // device would otherwise refuse the only shell it has.
    assert.equal(isAllowedCommand(new Set(['cmd']), 'cmd.exe', 'win32'), true)
    assert.equal(isAllowedCommand(new Set(['cmd.exe']), 'cmd', 'win32'), true)
  })

  it('matches Windows program names case-insensitively', () => {
    assert.equal(isAllowedCommand(new Set(['cmd']), 'CMD.EXE', 'win32'), true)
    assert.equal(isAllowedCommand(new Set(['CMD']), 'cmd.exe', 'win32'), true)
  })

  it('keeps POSIX names exact, where .exe and case carry meaning', () => {
    assert.equal(isAllowedCommand(new Set(['bash']), 'bash.exe', 'linux'), false)
    assert.equal(isAllowedCommand(new Set(['cmd']), 'CMD', 'linux'), false)
  })
})
