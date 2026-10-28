/**
 * The writable-root derivation shared by every enforcement dialect that
 * expresses a mode as a canonical allow-list: `workspace-write` means "the
 * workspace root, explicit extra directories, and platform temp areas", and this module is that
 * meaning's one home. The Seatbelt profile
 * (`@deepseek-ai/dsh-sandbox-local`) and the in-process filesystem fence
 * (`@deepseek-ai/dsh-fs-sandbox`) both derive their allow-list here, so "the
 * write tool cannot write /tmp but bash can" asymmetries cannot arise between
 * them. The bwrap and Landlock dialects keep their own grant spellings (an
 * ephemeral `/tmp` mount, launcher-owned flags) — the honest per-runner
 * differences recorded in the sandbox RFC — with parity pinned by test; both
 * read {@link workspaceWritableRoots} rather than re-deriving the extra grants.
 *
 * @module dsh-sandbox/roots
 */

import { realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SandboxExecutionPolicy } from './index.ts'

/** An explicit directory grant cannot be enforced without changing the caller's selected path. */
export class SandboxInvalidRootError extends HarnessError {
  constructor(path: string, detail: string) {
    super(`Invalid additional writable directory ${JSON.stringify(path)}: ${detail}`, 'SANDBOX_INVALID_ROOT')
    this.name = 'SandboxInvalidRootError'
  }
}

/**
 * Reject mutable path aliases before they can redirect an explicit grant, plus
 * the two grants that cannot mean what they say: the filesystem root, which is
 * `danger-full-access` by another name, and an ancestor of a mount the mode
 * itself installs, which the bwrap dialect would bind last and thereby
 * re-expose everything that mount hides.
 * @param policy - the file-effect policy whose mode owns the mounts.
 * @param path - the configured extra root.
 * @returns the canonical root to grant.
 * @throws {SandboxInvalidRootError} The entry cannot be enforced as written.
 */
function additionalRoot(policy: SandboxExecutionPolicy, path: string): string {
  let physical: string
  let directory: boolean
  try {
    physical = realpathSync.native(path)
    directory = statSync(physical).isDirectory()
  } catch (error) {
    throw new SandboxInvalidRootError(path, `cannot read the directory: ${String(error)}`)
  }
  if (!directory) throw new SandboxInvalidRootError(path, 'expected an existing directory')
  if (physical !== resolve(path)) {
    throw new SandboxInvalidRootError(path, `use the physical directory path ${JSON.stringify(physical)}; symlinked grants are not supported`)
  }
  if (physical === '/') {
    throw new SandboxInvalidRootError(path, 'the filesystem root grants everything; use danger-full-access to say so')
  }
  const shadowed = modeOwnedRoots(policy).find(owned => isUnder(owned, physical))
  if (shadowed !== undefined) {
    throw new SandboxInvalidRootError(path, `granting it would re-expose the mode-owned mount ${JSON.stringify(shadowed)}`)
  }
  return physical
}

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

/**
 * The roots the mode itself grants as writable, canonical and undeduplicated:
 * the policy's workspace root plus the host `/tmp` and the per-user platform
 * temp dir (`os.tmpdir()` — the real temp area for mkstemp-family tools;
 * omitting it would deny what the mode promises). These are also the mounts the
 * bwrap dialect installs, which is what {@link additionalRoot} tests a grant
 * against.
 * @param policy - the file-effect policy whose mode owns the mounts.
 * @returns the canonical mode-owned writable roots.
 */
function modeOwnedRoots(policy: SandboxExecutionPolicy): string[] {
  return [policy.workspaceRoot, '/tmp', tmpdir()].map(canonicalPath)
}

/** Whether `path` is `root` itself or sits beneath it, compared on path segments. */
function isUnder(path: string, root: string): boolean {
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  return path === base || path.startsWith(`${base}/`)
}

/**
 * The policy's extra writable grants, validated and independent of mode.
 *
 * {@link workspaceWritableRoots} gates them on `workspace-write` because only
 * that mode writes them; the read boundary re-exposes them in every mode,
 * because granting a directory is about writing and a grant never narrows what
 * the caller may read.
 * @param policy - the file-effect policy carrying the grants.
 * @returns the canonical granted roots, in configuration order.
 * @throws {SandboxInvalidRootError} An entry cannot be enforced as written.
 */
function extraWritableRoots(policy: SandboxExecutionPolicy): string[] {
  return [...new Set((policy.additionalWritableRoots ?? []).map(root => additionalRoot(policy, root)))]
}

/**
 * The workspace-owned writable roots — the policy's workspace root plus its
 * explicit extra directories, as a canonical, deduplicated allow-list. Both
 * the workspace and every extra root must be granted together by every
 * backend; this is the one derivation of that set, kept separate from the
 * platform temp policy each backend documents for itself (Seatbelt and the fs
 * fence use {@link writableRoots}; bwrap and Landlock add their own temp
 * grants).
 * @param policy - the file-effect policy to derive the allow-list from.
 * @returns the canonical workspace-owned roots; empty under `read-only`.
 * @throws {SandboxInvalidRootError} An extra root is missing, is not a directory,
 * uses a symlink, names the filesystem root, or would shadow a mount the mode installs.
 */
export function workspaceWritableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([canonicalPath(policy.workspaceRoot), ...extraWritableRoots(policy)])]
}

/**
 * The roots one confined execution may WRITE under — the mode's meaning as a
 * canonical, deduplicated allow-list. `read-only` allows nothing;
 * `workspace-write` allows the policy's workspace root, its explicit extra
 * directories, the host `/tmp`, and the per-user platform temp dir
 * (`os.tmpdir()` — the real temp area for mkstemp-family tools; omitting it
 * would deny what the mode promises).
 * @param policy - the file-effect policy to derive the allow-list from.
 * @returns the canonical writable roots; empty exactly under `read-only`.
 */
export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([...workspaceWritableRoots(policy), canonicalPath('/tmp'), canonicalPath(tmpdir())])]
}

/**
 * The read boundary one confined execution enforces, as a canonical
 * denied/re-exposed pair. Like {@link writableRoots}, this is the meaning's one
 * home so the enforcement dialects cannot drift into disagreeing about which
 * sibling directories a tenant may read.
 *
 * An allowed root that is not inside any denied root is dropped: re-exposing a
 * path nothing hides would grant a read the caller never asked to widen, and
 * the bwrap dialect cannot express it either (it has no mount to bind over).
 * Granting a directory writable means it must stay readable too, so the
 * policy's extra writable grants join the re-exposure list before that filter —
 * a grant inside a denied root is buried by the shield and must be bound back,
 * while one outside stays dropped because nothing hides it.
 *
 * @param policy - the file-effect policy to derive the read boundary from.
 * @returns canonical denied roots and the canonical allowed subtrees inside
 *   them; both empty when the policy names no read shield.
 */
export function readShield(policy: SandboxExecutionPolicy): { denied: string[]; allowed: string[] } {
  const denied = [...new Set((policy.readDeniedRoots ?? []).map(canonicalPath))].filter(root => root !== '/')
  if (denied.length === 0) return { denied: [], allowed: [] }
  const reexposed = [...(policy.readAllowedRoots ?? []), ...extraWritableRoots(policy)]
  const allowed = [...new Set(reexposed.map(canonicalPath))]
    .filter(root => denied.some(hidden => isUnder(root, hidden)))
  return { denied, allowed }
}
