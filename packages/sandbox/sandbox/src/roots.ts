/**
 * The writable-root derivation shared by every enforcement dialect that
 * expresses a mode as a canonical allow-list: `workspace-write` means "the
 * workspace root plus the platform temp areas, plus whatever extra directories
 * the policy grants", and this module is that meaning's one home. The Seatbelt
 * profile
 * (`@deepseek-ai/dsh-sandbox-local`) and the in-process filesystem fence
 * (`@deepseek-ai/dsh-fs-sandbox`) both derive their allow-list here, so "the
 * write tool cannot write /tmp but bash can" asymmetries cannot arise between
 * them. The bwrap and Landlock dialects keep their own grant spellings (an
 * ephemeral `/tmp` mount, launcher-owned flags) — the honest per-runner
 * differences recorded in the sandbox RFC — with parity pinned by test; both
 * read {@link effectiveRwRoots} rather than re-deriving the extra grants.
 *
 * @module dsh-sandbox/roots
 */

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute } from 'node:path'
import type { SandboxExecutionPolicy } from './index.ts'

/**
 * Resolve a granted root to the path the enforcement layer actually compares:
 * canonical (symlinks resolved), because both Seatbelt filters and the fs
 * fence's containment check match resolved paths — `/tmp` IS `/private/tmp`
 * on darwin, and an as-spelled grant would match nothing.
 * @param path - the root as configured or platform-reported.
 * @returns the canonical path, or the spelling as-is when resolution fails
 *   (a missing root matches nothing until it exists — the conservative
 *   outcome; inventing a fallback would grant a path the caller never named).
 */
export function canonicalPath(path: string): string {
  try {
    // Node's JavaScript realpath implementation lexically collapses `..`
    // before resolving a preceding symlink on some platforms. The native
    // implementation follows the filesystem's component-by-component lookup,
    // matching chdir/spawn and the enforcement layers this identity feeds.
    return realpathSync.native(path)
  } catch {
    // realpathSync.native failed: the path (or a prefix) is missing or unreadable.
    return path
  }
}

/**
 * The roots the mode itself grants as writable, canonical and undeduplicated:
 * the policy's workspace root plus the host `/tmp` and the per-user platform
 * temp dir (`os.tmpdir()` — the real temp area for mkstemp-family tools;
 * omitting it would deny what the mode promises). These three are also the
 * mounts the mode installs, which is what {@link shadowsModeOwnedMount} tests a
 * granted root against.
 */
function modeOwnedRoots(policy: SandboxExecutionPolicy): string[] {
  return [policy.workspaceRoot, '/tmp', tmpdir()].map(canonicalPath)
}

/**
 * Whether binding `root` would replace a mount the mode installs. The bwrap
 * dialect's mode section mounts an ephemeral `/tmp` and binds the workspace
 * root over it; a writable root that is such a path's ancestor would be bound
 * last and re-expose everything that mount hides. Only `workspace-write`
 * installs those mounts, so only there can a grant shadow one.
 * @param policy - the file-effect policy whose mode owns the mounts.
 * @param root - the canonical granted root to test.
 * @returns whether the grant must be discarded instead of applied.
 */
function shadowsModeOwnedMount(policy: SandboxExecutionPolicy, root: string): boolean {
  if (policy.mode !== 'workspace-write') return false
  return modeOwnedRoots(policy).some(owned => isUnder(owned, root))
}

/**
 * The policy's extra granted roots after canonicalization and the safety
 * discard, independent of mode — the read boundary re-exposes them wherever the
 * mode reaches, while {@link effectiveRwRoots} decides whether a mode writes
 * them.
 *
 * Discarded: a relative entry (nothing to compare canonically), `/` (that is
 * `danger-full-access` by another name), and any entry that would shadow a
 * mode-owned mount. Discarding only ever removes a grant, so the outcome stays
 * fail-closed.
 * @param policy - the file-effect policy carrying the grants.
 * @returns the canonical granted roots, in configuration order.
 */
function grantedExtraRoots(policy: SandboxExecutionPolicy): string[] {
  return [...new Set((policy.rwRoots ?? []).map(canonicalPath))]
    .filter(root => isAbsolute(root))
    .filter(root => root !== '/')
    .filter(root => !shadowsModeOwnedMount(policy, root))
}

/**
 * The extra roots one confined execution may WRITE under, gated by the mode.
 * `read-only` grants nothing and `danger-full-access` needs nothing, so only
 * `workspace-write` yields entries — an empty result therefore preserves the
 * pre-existing mode semantics exactly.
 *
 * The bwrap and Landlock dialects each spell their own write grant, so both
 * read this list rather than re-deriving it; that keeps a grant from landing in
 * one dialect's profile and not the other's.
 * @param policy - the file-effect policy to derive the granted roots from.
 * @returns the canonical extra writable roots; empty outside `workspace-write`.
 */
export function effectiveRwRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  return grantedExtraRoots(policy)
}

/**
 * The roots one confined execution may WRITE under — the mode's meaning as a
 * canonical, deduplicated allow-list. `read-only` allows nothing;
 * `workspace-write` allows the policy's workspace root, the host `/tmp`, the
 * per-user platform temp dir, and the policy's own {@link effectiveRwRoots}
 * grants.
 * @param policy - the file-effect policy to derive the allow-list from.
 * @returns the canonical writable roots; empty exactly under `read-only`.
 */
export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([...modeOwnedRoots(policy), ...effectiveRwRoots(policy)])]
}

/**
 * The read boundary one confined execution enforces, as a canonical
 * denied/re-exposed pair. Like {@link writableRoots}, this is the meaning's one
 * home so the three enforcement dialects cannot drift into disagreeing about
 * which sibling directories a tenant may read.
 *
 * An allowed root that is not inside any denied root is dropped: re-exposing a
 * path nothing hides would grant a read the caller never asked to widen, and
 * the bwrap dialect cannot express it either (it has no mount to bind over).
 * Granting a directory writable means it must stay readable too, so the
 * policy's extra grants join the re-exposure list before that filter — a grant
 * inside a denied root is buried by the shield and must be bound back, while one
 * outside stays dropped because nothing hides it.
 *
 * @param policy - the file-effect policy to derive the read boundary from.
 * @returns canonical denied roots and the canonical allowed subtrees inside
 *   them; both empty when the policy names no read shield.
 */
export function readShield(policy: SandboxExecutionPolicy): { denied: string[]; allowed: string[] } {
  const denied = [...new Set((policy.readDeniedRoots ?? []).map(canonicalPath))].filter(root => root !== '/')
  if (denied.length === 0) return { denied: [], allowed: [] }
  const reexposed = [...(policy.readAllowedRoots ?? []), ...grantedExtraRoots(policy)]
  const allowed = [...new Set(reexposed.map(canonicalPath))]
    .filter(root => denied.some(hidden => isUnder(root, hidden)))
  return { denied, allowed }
}

/** Whether `path` is `root` itself or sits beneath it, compared on path segments. */
function isUnder(path: string, root: string): boolean {
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  return path === base || path.startsWith(`${base}/`)
}
