/**
 * Profile plugin management of `dsh-app-boot`: the shared bundle-layer
 * reconcile used by the `dsh plugin` CLI and the host plugin-install remote.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readProfileManifest, reconcileProfileBundles, writeProfileManifest } from '../src/index.ts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-profile-plugins-'))

/** Stage a fake package under a node_modules root (app or profile). */
function stagePackage(root: string, name: string, opts: { bundle?: boolean }): void {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '0.0.0',
    type: 'module',
    main: './index.js',
    ...opts.bundle === true ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {},
  }))
  writeFileSync(join(dir, 'index.js'), `export const packageName = ${JSON.stringify(name)}\n`)
  if (opts.bundle === true) writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
}

/**
 * Stage the post-pnpm profile state: node_modules holds the packages and the
 * on-disk manifest lists the current dependencies. Reconcile reads the disk
 * manifest as the `after` state; the caller-supplied `before` snapshot is the
 * pre-pnpm manifest (old dependency set), passed to the function, never
 * written back to disk.
 */
function stageAfterState(dir: string, deps: Record<string, { bundle?: boolean }>): void {
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  for (const [name, spec] of Object.entries(deps)) {
    stagePackage(dir, name, spec)
  }
  const manifest = { name: 'dsh-profile-test', dependencies: Object.fromEntries(Object.keys(deps).map(name => [name, '0.0.0'])) }
  writeProfileManifest(dir, manifest)
}

/** Install anchor: an app dir whose node_modules holds the same package set. */
function stageInstallAnchor(names: readonly string[]): string {
  const root = tmp()
  for (const name of names) stagePackage(root, name, { bundle: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dsh-app', version: '0.0.0', dependencies: {} }))
  return join(root, 'package.json')
}

describe('reconcileProfileBundles', () => {
  it('adds a newly installed bundle dependency to the layer stack', () => {
    const dir = tmp()
    const installAnchor = stageInstallAnchor([])
    // `before` = manifest pnpm saw before writing the dependency.
    const before = { name: 'dsh-profile-test', dependencies: {} }
    stageAfterState(dir, { 'external-bundle': { bundle: true } })
    const warnings: string[] = []
    const result = reconcileProfileBundles({
      binName: 'dsh', installAnchor, profileDir: dir, before, warn: message => warnings.push(message),
    })
    expect(result.changed).toBe(true)
    expect(result.added).toEqual(['external-bundle'])
    expect(readProfileManifest('dsh', dir).dsh?.profile?.bundles).toEqual(['external-bundle'])
    expect(warnings).toEqual([])
  })

  it('warns on a new plain dependency without promoting it to a layer', () => {
    const dir = tmp()
    const installAnchor = stageInstallAnchor([])
    const before = { name: 'dsh-profile-test', dependencies: {} }
    stageAfterState(dir, { 'plain-lib': { bundle: false } })
    const warnings: string[] = []
    const result = reconcileProfileBundles({
      binName: 'dsh', installAnchor, profileDir: dir, before, warn: message => warnings.push(message),
    })
    expect(result.changed).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('declares no dsh.bundle')
    expect(readProfileManifest('dsh', dir).dsh?.profile?.bundles ?? []).toEqual([])
  })

  it('keeps template bundles that are not dependencies untouched', () => {
    const dir = tmp()
    const installAnchor = stageInstallAnchor([])
    stageAfterState(dir, {})
    // The on-disk manifest carries the template layer (dsh-base) plus no deps.
    writeProfileManifest(dir, {
      name: 'dsh-profile-test',
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    })
    const before = { name: 'dsh-profile-test', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }
    const result = reconcileProfileBundles({
      binName: 'dsh', installAnchor, profileDir: dir, before, warn: () => {},
    })
    expect(result.changed).toBe(false)
    expect(readProfileManifest('dsh', dir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
  })

  it('removes a dependency-managed layer whose dependency pnpm removed', () => {
    const dir = tmp()
    const installAnchor = stageInstallAnchor([])
    // Before: dependency present and promoted to the layer stack.
    const before = {
      name: 'dsh-profile-test',
      dependencies: { 'was-bundle': '0.0.0' },
      dsh: { profile: { bundles: ['was-bundle'] } },
    }
    // After: pnpm removed the dependency; the stale layer entry must leave.
    stageAfterState(dir, {})
    writeProfileManifest(dir, {
      name: 'dsh-profile-test',
      dependencies: {},
      dsh: { profile: { bundles: ['was-bundle'] } },
    })
    const result = reconcileProfileBundles({
      binName: 'dsh', installAnchor, profileDir: dir, before, warn: () => {},
    })
    expect(result.changed).toBe(true)
    expect(result.removed).toEqual(['was-bundle'])
    expect(readProfileManifest('dsh', dir).dsh?.profile?.bundles ?? []).toEqual([])
  })

  it('resolves an in-box bundle from the installation anchor when not profile-local', () => {
    const dir = tmp()
    const installAnchor = stageInstallAnchor(['in-box-bundle'])
    const before = { name: 'dsh-profile-test', dependencies: {} }
    mkdirSync(dir, { recursive: true })
    // Dependency installed (resolves only against the install anchor), no profile-local copy.
    writeProfileManifest(dir, { name: 'dsh-profile-test', dependencies: { 'in-box-bundle': '0.0.0' } })
    const warnings: string[] = []
    const result = reconcileProfileBundles({
      binName: 'dsh', installAnchor, profileDir: dir, before, warn: message => warnings.push(message),
    })
    expect(result.added).toEqual(['in-box-bundle'])
    expect(warnings).toEqual([])
  })
})
