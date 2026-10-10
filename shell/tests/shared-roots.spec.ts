/**
 * The deployment's shared-directory mapping, resolved per account.
 *
 * These cases pin the two properties the feature rests on: a malformed mapping
 * grants nothing rather than failing provisioning, and a grant that would
 * disturb the mount shadow tree is dropped. Both are fail-closed, so a bug here
 * shows up as either a broken spawn or an exposed sibling account.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseSharedRoots, resolveSharedRoots, NO_SHARED_ROOTS } from '../src/shared-roots.ts'

const USERS_ROOT = '/home/team/.dsh-users'
const SHADOW_ROOT = '/tmp/dsh-shadow'

const mapping = (value: unknown): string => JSON.stringify(value)

describe('parseSharedRoots tolerance', () => {
  it('grants nothing for an absent, empty, or unparsable value', () => {
    assert.deepEqual(parseSharedRoots(undefined, USERS_ROOT, SHADOW_ROOT), [])
    assert.deepEqual(parseSharedRoots('', USERS_ROOT, SHADOW_ROOT), [])
    assert.deepEqual(parseSharedRoots('   ', USERS_ROOT, SHADOW_ROOT), [])
    assert.deepEqual(parseSharedRoots('{not json', USERS_ROOT, SHADOW_ROOT), [])
    assert.deepEqual(parseSharedRoots('"a string"', USERS_ROOT, SHADOW_ROOT), [])
    assert.deepEqual(parseSharedRoots('{"path":"/srv/x"}', USERS_ROOT, SHADOW_ROOT), [], 'an object is not a list')
  })

  it('skips malformed entries but keeps the well-formed ones beside them', () => {
    const entries = parseSharedRoots(mapping([
      null,
      42,
      'string',
      {},
      { path: '' },
      { path: 7 },
      { path: 'relative/share' },
      { path: '/srv/share/common' },
    ]), USERS_ROOT, SHADOW_ROOT)
    assert.deepEqual(entries.map(entry => entry.path), ['/srv/share/common'])
  })

  it('substitutes the users-root placeholder and normalizes the spelling', () => {
    const entries = parseSharedRoots(mapping([
      { path: '<usersRoot>/shared/common' },
      { path: '<usersRoot>/shared/./admin/' },
    ]), USERS_ROOT, SHADOW_ROOT)
    assert.deepEqual(entries.map(entry => entry.path), [`${USERS_ROOT}/shared/common`, `${USERS_ROOT}/shared/admin`])
  })

  it('drops the filesystem root, which no shared grant should ever name', () => {
    assert.deepEqual(parseSharedRoots(mapping([{ path: '/' }]), USERS_ROOT, SHADOW_ROOT), [])
  })
})

describe('parseSharedRoots shadow-tree guard', () => {
  it('drops a grant that contains the shadow root, which would re-expose every account', () => {
    const raw = mapping([
      { path: '/tmp' },
      { path: SHADOW_ROOT },
      { path: '/tmp/dsh-shadow/../dsh-shadow' },
      { path: '/srv/share/common' },
    ])
    assert.deepEqual(
      parseSharedRoots(raw, USERS_ROOT, SHADOW_ROOT).map(entry => entry.path),
      ['/srv/share/common'],
      'the sandbox hides other accounts by mounting an ephemeral tmpfs over /tmp; binding over it undoes that',
    )
  })

  it('drops a grant inside the shadow tree, which names a mirror rather than server data', () => {
    assert.deepEqual(
      parseSharedRoots(mapping([{ path: `${SHADOW_ROOT}/winslow/pairing@HOST` }]), USERS_ROOT, SHADOW_ROOT),
      [],
    )
  })

  it('keeps a sibling that merely shares a prefix with the shadow root', () => {
    const entries = parseSharedRoots(mapping([{ path: `${SHADOW_ROOT}-elsewhere` }]), USERS_ROOT, SHADOW_ROOT)
    assert.deepEqual(entries.map(entry => entry.path), [`${SHADOW_ROOT}-elsewhere`])
  })
})

describe('resolveSharedRoots by role', () => {
  const entries = parseSharedRoots(mapping([
    { path: '<usersRoot>/shared/common' },
    { path: '<usersRoot>/shared/admin', roles: ['operator'] },
    { path: '<usersRoot>/shared/kit', roles: ['operator', 'member'], write: false },
  ]), USERS_ROOT, SHADOW_ROOT)

  it('gives an operator the administrator directory and the shared ones', () => {
    const roots = resolveSharedRoots(entries, 'operator')
    assert.deepEqual(roots.writable, [`${USERS_ROOT}/shared/common`, `${USERS_ROOT}/shared/admin`])
    assert.deepEqual(roots.readable, [...roots.writable, `${USERS_ROOT}/shared/kit`])
  })

  it('withholds the administrator directory from a member', () => {
    const roots = resolveSharedRoots(entries, 'member')
    assert.deepEqual(roots.writable, [`${USERS_ROOT}/shared/common`])
    assert.deepEqual(roots.readable, [`${USERS_ROOT}/shared/common`, `${USERS_ROOT}/shared/kit`])
  })

  it('keeps a readable-only root out of the writable list', () => {
    assert.ok(!resolveSharedRoots(entries, 'member').writable.includes(`${USERS_ROOT}/shared/kit`))
  })

  it('treats an entry without roles as granted to every role', () => {
    for (const role of ['operator', 'member', 'something-new']) {
      assert.ok(resolveSharedRoots(entries, role).readable.includes(`${USERS_ROOT}/shared/common`))
    }
  })

  it('grants nothing when the account role matches no entry', () => {
    const explicit = parseSharedRoots(mapping([
      { path: '/srv/share/common', roles: ['member'] },
      { path: '/srv/share/admin', roles: ['operator'] },
    ]), USERS_ROOT, SHADOW_ROOT)
    assert.deepEqual(resolveSharedRoots(explicit, 'nobody'), NO_SHARED_ROOTS)
  })

  it('grants nothing when the mapping parsed to no entries', () => {
    assert.deepEqual(resolveSharedRoots([], 'operator'), NO_SHARED_ROOTS)
  })

  it('deduplicates a readable-only entry that repeats a writable one', () => {
    const repeated = parseSharedRoots(mapping([
      { path: '/srv/share/team' },
      { path: '/srv/share/team', write: false },
    ]), USERS_ROOT, SHADOW_ROOT)
    const roots = resolveSharedRoots(repeated, 'member')
    assert.deepEqual(roots.writable, ['/srv/share/team'])
    assert.deepEqual(roots.readable, ['/srv/share/team'])
  })
})
