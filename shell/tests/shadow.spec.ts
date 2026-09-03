import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shadowPathFor } from '../src/remote/hub.ts'
import { translateShadowPath, isShadowPath, shadowRelative } from '../src/remote/shadow.ts'
import type { MountRecord } from '../src/remote/hub.ts'

const SHADOW_ROOT = '/var/lib/dsh-mounts'

function mount(user: string, agentId: string, root: string, ordinal = 0): MountRecord {
  return {
    agentId,
    user,
    root,
    shadowPath: shadowPathFor(user, agentId, root, ordinal, SHADOW_ROOT),
  }
}

describe('shadowPathFor', () => {
  it('maps a user/agent/root to a stable shadow path under the root', () => {
    assert.equal(shadowPathFor('alice', 'wh1', 'D:\\workspace', 0, SHADOW_ROOT), '/var/lib/dsh-mounts/alice/wh1')
    assert.equal(shadowPathFor('alice', 'wh1', '/home', 1, SHADOW_ROOT), '/var/lib/dsh-mounts/alice/wh1/root1')
  })

  it('sanitizes agent ids for path safety', () => {
    const p = shadowPathFor('bob', 'pairing@win host:1', '/x', 0, SHADOW_ROOT)
    assert.ok(!p.includes(' '))
    assert.ok(!p.includes(':'))
    assert.ok(p.startsWith('/var/lib/dsh-mounts/bob/'))
  })
})

describe('translateShadowPath', () => {
  const mounts = [
    mount('alice', 'wh1', 'D:\\workspace'),
    mount('bob', 'linux1', '/home/bob/code'),
  ]

  it('translates a POSIX-root mount to the agent path', () => {
    const t = translateShadowPath('/var/lib/dsh-mounts/bob/linux1/lib/mod.ts', mounts)
    assert.equal(t?.user, 'bob')
    assert.equal(t?.remotePath, '/home/bob/code/lib/mod.ts')
  })

  it('translates a Windows-root mount using backslash joins', () => {
    const t = translateShadowPath('/var/lib/dsh-mounts/alice/wh1/src/app.ts', mounts)
    assert.equal(t?.user, 'alice')
    assert.equal(t?.remotePath, 'D:\\workspace\\src\\app.ts')
  })

  it('translates the shadow root itself to the agent root', () => {
    const t = translateShadowPath('/var/lib/dsh-mounts/alice/wh1', mounts)
    assert.equal(t?.remotePath, 'D:\\workspace')
  })

  it('returns undefined for an unknown shadow path', () => {
    assert.equal(translateShadowPath('/var/lib/dsh-mounts/nobody/x', mounts), undefined)
    assert.equal(translateShadowPath('/etc/passwd', mounts), undefined)
  })

  it('prefers the longest (deepest) matching mount', () => {
    const deep = mount('carol', 'deep', '/srv/data', 0)
    const nested = {
      ...deep,
      shadowPath: '/var/lib/dsh-mounts/carol/deep/sub',
      root: '/srv/data/sub',
    } as MountRecord
    const t = translateShadowPath('/var/lib/dsh-mounts/carol/deep/sub/x.txt', [...mounts, deep, nested])
    assert.equal(t?.remotePath, '/srv/data/sub/x.txt')
  })
})

describe('shadow helpers', () => {
  it('recognizes paths inside the shadow root', () => {
    assert.equal(isShadowPath('/var/lib/dsh-mounts/alice/wh1/f.txt', SHADOW_ROOT), true)
    assert.equal(isShadowPath('/etc/f.txt', SHADOW_ROOT), false)
  })

  it('computes the shadow-relative portion', () => {
    assert.equal(shadowRelative('/var/lib/dsh-mounts/alice/wh1/f.txt', SHADOW_ROOT), 'alice/wh1/f.txt')
    assert.equal(shadowRelative('/etc/f.txt', SHADOW_ROOT), undefined)
  })
})
