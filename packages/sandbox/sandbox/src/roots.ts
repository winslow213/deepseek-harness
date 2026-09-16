/**
 * The writable-root derivation shared by every enforcement dialect that
 * expresses a mode as a canonical allow-list: `workspace-write` means "the
 * workspace root plus the platform temp areas", and this module is that
 * meaning's one home. The Seatbelt profile
 * (`@deepseek-ai/dsh-sandbox-local`) and the in-process filesystem fence
 * (`@deepseek-ai/dsh-fs-sandbox`) both derive their allow-list here, so "the
 * write tool cannot write /tmp but bash can" asymmetries cannot arise between
 * them. The bwrap and Landlock dialects keep their own grant spellings (an
 * ephemeral `/tmp` mount, launcher-owned flags) — the honest per-runner
 * differences recorded in the sandbox RFC — with parity pinned by test.
 *
 * @module dsh-sandbox/roots
 */

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
 * The roots one confined execution may WRITE under — the mode's meaning as a
 * canonical, deduplicated allow-list. `read-only` allows nothing;
 * `workspace-write` allows the policy's workspace root, the host `/tmp`, and
 * the per-user platform temp dir (`os.tmpdir()` — the real temp area for
 * mkstemp-family tools; omitting it would deny what the mode promises).
 * @param policy - the file-effect policy to derive the allow-list from.
 * @returns the canonical writable roots; empty exactly under `read-only`.
 */
export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([policy.workspaceRoot, '/tmp', tmpdir()].map(canonicalPath))]
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
 *
 * @param policy - the file-effect policy to derive the read boundary from.
 * @returns canonical denied roots and the canonical allowed subtrees inside
 *   them; both empty when the policy names no read shield.
 */
export function readShield(policy: SandboxExecutionPolicy): { denied: string[]; allowed: string[] } {
  const denied = [...new Set((policy.readDeniedRoots ?? []).map(canonicalPath))].filter(root => root !== '/')
  if (denied.length === 0) return { denied: [], allowed: [] }
  const allowed = [...new Set((policy.readAllowedRoots ?? []).map(canonicalPath))]
    .filter(root => denied.some(hidden => isUnder(root, hidden)))
  return { denied, allowed }
}

/** Whether `path` is `root` itself or sits beneath it, compared on path segments. */
function isUnder(path: string, root: string): boolean {
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  return path === base || path.startsWith(`${base}/`)
}
