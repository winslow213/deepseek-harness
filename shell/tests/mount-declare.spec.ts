import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMountedWorkspace } from '../src/remote/mount-declare-render.ts'
import { shadowPathFor } from '../src/remote/hub.ts'
import type { MountRecord } from '../src/remote/hub.ts'

const SHADOW_ROOT = '/tmp/dsh-shadow'

function mount(user: string, agentId: string, root: string, ordinal = 0): MountRecord {
  return {
    agentId,
    user,
    root,
    shadowPath: shadowPathFor(user, agentId, root, ordinal, SHADOW_ROOT),
  }
}

describe('renderMountedWorkspace', () => {
  const aliceWh1 = mount('alice', 'wh1', 'D:\\workspace')
  const aliceWh2 = mount('alice', 'wh2', 'C:\\Users\\alice\\code')
  const bobMount = mount('bob', 'linux1', '/home/bob/code')

  it('returns empty when the cwd is absent', () => {
    assert.equal(renderMountedWorkspace(undefined, [aliceWh1], 'alice', SHADOW_ROOT), '')
  })

  it('returns empty for a local (non-shadow) cwd', () => {
    assert.equal(renderMountedWorkspace('/home/alice/project', [aliceWh1], 'alice', SHADOW_ROOT), '')
  })

  it('declares the matching mount and lists every mount the user owns', () => {
    const text = renderMountedWorkspace(aliceWh1.shadowPath, [aliceWh1, aliceWh2, bobMount], 'alice', SHADOW_ROOT)
    assert.ok(text.includes('D:\\workspace'))
    assert.ok(text.includes('agent wh1'))
    assert.ok(text.includes('C:\\Users\\alice\\code'))
    assert.ok(text.includes('agent wh2'))
    assert.ok(text.includes(aliceWh1.shadowPath))
    assert.ok(!text.includes('/home/bob/code'))
    assert.ok(!text.includes('agent linux1'))
  })

  it('names the local user space and its A2UI tools dir when home is given', () => {
    const home = '/home/winslow/.dsh-users/alice'
    const text = renderMountedWorkspace(aliceWh1.shadowPath, [aliceWh1], 'alice', SHADOW_ROOT, home)
    assert.ok(text.includes(home))
    assert.ok(text.includes(`${home}/a2ui-tools`))
    assert.ok(text.includes('A2UI tools'))
  })

  it('omits the local user space line when home is empty', () => {
    const text = renderMountedWorkspace(aliceWh1.shadowPath, [aliceWh1], 'alice', SHADOW_ROOT)
    assert.ok(!text.includes('a2ui-tools'))
    assert.ok(!text.includes('local user space'))
  })

  it('returns empty when the matching mount belongs to another user', () => {
    assert.equal(renderMountedWorkspace(bobMount.shadowPath, [bobMount], 'alice', SHADOW_ROOT), '')
  })

  it('scales to any mount count without hardcoding a path', () => {
    // No mounts: nothing to translate, no declaration.
    assert.equal(renderMountedWorkspace(aliceWh1.shadowPath, [], 'alice', SHADOW_ROOT), '')
    const one = renderMountedWorkspace(aliceWh1.shadowPath, [aliceWh1], 'alice', SHADOW_ROOT)
    assert.ok(one.includes('D:\\workspace'))
    const three = renderMountedWorkspace(
      aliceWh1.shadowPath,
      [aliceWh1, aliceWh2, mount('alice', 'wh3', 'E:\\third')],
      'alice',
      SHADOW_ROOT,
    )
    assert.ok(three.includes('E:\\third'))
    assert.ok(three.includes('agent wh3'))
  })
})
