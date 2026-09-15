import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveLstatTarget } from '../src/remote/agent.ts'

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
