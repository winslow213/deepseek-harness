/**
 * Profile plugin management shared by the `dsh plugin` CLI forwarder and the
 * host plugin-install remote: bundle detection and layer reconciliation after
 * a dependency change.
 *
 * Both callers operate on one profile directory after `pnpm` has materialized
 * the requested dependency change, so the reconcile logic here is the single
 * owner of how `dsh.profile.bundles` tracks installed dependencies. Keeping it
 * in app-boot (not in the CLI) is what lets the in-instance host remote reuse
 * the same semantics instead of re-deriving them.
 * @module @deepseek-ai/dsh-app-boot/profile-plugins
 */

import { readProfileManifest, resolveBundleDir, writeProfileManifest } from './profile.ts'
import type { ProfileManifest } from './profile.ts'

/**
 * Whether a resolved dependency exports a profile patch, i.e. is a bundle.
 * Unresolvable packages are not bundles (the caller has already reported the
 * pnpm error separately); a bundle-less dependency stays a plain library.
 * @param binName - the diagnostic prefix used on resolution failures.
 * @param packageName - the dependency's package name.
 * @param installAnchor - the dsh installation anchor used for in-box bundles.
 * @param profileDir - the profile directory (resolution anchor for installed packages).
 * @returns true when the package manifest declares `dsh.bundle`.
 */
export function dependencyIsBundle(
  binName: string,
  packageName: string,
  installAnchor: string,
  profileDir: string,
): boolean {
  let dir: string
  try {
    dir = resolveBundleDir(binName, packageName, installAnchor, profileDir)
  } catch {
    return false // pnpm reported success yet the package is unresolvable — treat as plain
  }
  const manifest = readProfileManifest(binName, dir)
  return manifest.dsh?.bundle?.patch !== undefined
}

export interface ReconcileProfileBundlesResult {
  /** Whether the manifest changed (bundles added or removed). */
  readonly changed: boolean
  /** Names appended to `dsh.profile.bundles`, in dependency order. */
  readonly added: readonly string[]
  /** Names removed from `dsh.profile.bundles`. */
  readonly removed: readonly string[]
}

export interface ReconcileProfileBundlesOptions {
  /** Diagnostic prefix used on manifest and resolution errors. */
  binName: string
  /** The dsh installation anchor (first resolution anchor for in-box bundles). */
  installAnchor: string
  /** The profile directory whose manifest reconciles. */
  profileDir: string
  /** The profile manifest read before pnpm ran; drives the new-dependency diff. */
  before: ProfileManifest
  /** Sink for the one-time orientation warning about a bundle-less new dependency. */
  warn: (message: string) => void
}

/**
 * Reconcile `dsh.profile.bundles` against the installed state: pnpm has
 * already written the real installed names (so a git/path/tarball/alias spec
 * reconciles by its true package name) and materialized the packages. A
 * dependency that resolves to a `dsh.bundle`-declaring package joins the layer
 * stack (appended in dependency order); a dependency-listed name that no
 * longer does — removed, or the installed version dropped the declaration —
 * leaves it. In-box bundles from the profile template are not dependencies
 * and are never touched. Warns once per newly-added bundle-less dependency (a
 * plain library is fine; the warning is orientation).
 *
 * Reads the current manifest from disk (the `after` state), so callers must
 * have persisted the dependency change first.
 * @param options - binName, resolution anchors, the before-manifest, and the warning sink.
 * @returns whether the layer list changed and what it gained or lost.
 */
export function reconcileProfileBundles(options: ReconcileProfileBundlesOptions): ReconcileProfileBundlesResult {
  const { binName, installAnchor, profileDir, before, warn } = options
  const after = readProfileManifest(binName, profileDir)
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.keys(after.dependencies ?? {})
  const plugins = [...after.dsh?.profile?.bundles ?? []]
  const added: string[] = []
  const removed: string[] = []
  for (const packageName of dependencies) {
    const isBundle = dependencyIsBundle(binName, packageName, installAnchor, profileDir)
    if (isBundle && !plugins.includes(packageName)) {
      plugins.push(packageName)
      added.push(packageName)
    } else if (!isBundle && !beforeDeps.has(packageName)) {
      warn(
        `${packageName} declares no dsh.bundle — installed as a plain dependency, not a profile layer `
        + '(a later update that gains one activates it automatically)',
      )
    }
  }
  const dependencySet = new Set(dependencies)
  for (const packageName of [...plugins]) {
    // Only dependency-managed entries are subject to removal; template
    // bundles (dsh-base and friends) are not dependencies.
    const wasDependency = beforeDeps.has(packageName) || dependencySet.has(packageName)
    const stillBundle = dependencySet.has(packageName) && dependencyIsBundle(binName, packageName, installAnchor, profileDir)
    if (wasDependency && !stillBundle) {
      plugins.splice(plugins.indexOf(packageName), 1)
      removed.push(packageName)
    }
  }
  const changed = added.length > 0 || removed.length > 0
  if (!changed) return { changed: false, added, removed }
  after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles: plugins } }
  writeProfileManifest(profileDir, after)
  return { changed: true, added, removed }
}
