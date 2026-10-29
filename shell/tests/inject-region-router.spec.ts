/**
 * The region-router patch the team shell writes into each account's profile.
 *
 * `readableRoots` is the ctx.fs read boundary's grant list: the router denies
 * every local read outside the account workspace, so a shared directory the
 * deployment granted is unreadable without it. The patch controls whether that
 * grant reaches the loaded plugin, so an emission bug shows up as a shared
 * directory that exists, is writable, and still cannot be listed.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { regionRouterPatchYaml } from '../src/remote/inject.ts'

const BASE = {
  hubUrl: 'http://127.0.0.1:7100',
  user: 'winslow',
  shadowRoot: '/tmp/dsh-shadow',
  workspaceRoot: '/home/winslow/.dsh-users/winslow/workspace',
  routerFileUrl: 'file:///plugins/region-router.ts',
}

describe('regionRouterPatchYaml readableRoots', () => {
  it('emits the grant list when the deployment configures one', () => {
    const patch = regionRouterPatchYaml({
      ...BASE,
      readableRoots: ['/home/winslow/.dsh-users/shared/common', '/home/winslow/.dsh-users/shared/admin'],
    })
    assert.match(
      patch,
      /^ {8}readableRoots: \["\/home\/winslow\/\.dsh-users\/shared\/common","\/home\/winslow\/\.dsh-users\/shared\/admin"\]$/m,
      'the grant list must reach the plugin config as a JSON array',
    )
  })

  it('omits the key entirely when no grant is configured, keeping the single-root boundary', () => {
    assert.doesNotMatch(regionRouterPatchYaml(BASE), /readableRoots/, 'an absent list must not appear as an empty one')
    assert.doesNotMatch(
      regionRouterPatchYaml({ ...BASE, readableRoots: [] }),
      /readableRoots/,
      'an empty list is the same statement as an absent one',
    )
  })

  it('keeps the workspace root as the read boundary alongside the grants', () => {
    const patch = regionRouterPatchYaml({ ...BASE, readableRoots: ['/srv/share'] })
    assert.match(patch, /^ {8}workspaceRoot: "\/home\/winslow\/\.dsh-users\/winslow\/workspace"$/m)
  })
})

describe('regionRouterPatchYaml terminal routing', () => {
  it('hands the subprocess router the user and hub its PTY frames are addressed by', () => {
    const patch = regionRouterPatchYaml({
      ...BASE,
      includeSubprocess: true,
      subprocessRouterFileUrl: 'file:///plugins/region-subprocess.ts',
    })
    assert.match(patch, /^ {4}- id: region-subprocess$/m, 'the router must be mounted in place of subprocess-local')
    assert.match(patch, /^ {8}hubUrl: "http:\/\/127\.0\.0\.1:7100"$/m)
    assert.match(patch, /^ {8}user: "winslow"$/m, 'the hub addresses agents by owner, so the router needs the user')
    assert.match(patch, /^ {8}shadowRoot: "\/tmp\/dsh-shadow"$/m, 'the same root decides filesystem routing and terminal eligibility')
  })

  it('leaves subprocess-local mounted when no router is configured', () => {
    assert.doesNotMatch(regionRouterPatchYaml(BASE), /region-subprocess/, 'an unconfigured deployment keeps local terminals')
  })
})
