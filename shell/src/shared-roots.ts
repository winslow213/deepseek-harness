/**
 * The deployment's shared directories, resolved per account.
 *
 * A shared directory is a server path several accounts may write, so its grant
 * list is per account and comes from two facts: the deployment's role mapping
 * (`TEAM_SHARED_ROOTS`) and the account's own `dsh_users.role`. This module
 * turns those into the two lists the account's profile needs — the roots its
 * sandbox may WRITE (`DSH_RW_ROOTS`) and the roots its `ctx.fs` read boundary
 * must re-expose (`DSH_READ_ALLOWED_ROOTS`).
 *
 * Pure and side-effect free: the caller owns where the environment and the role
 * come from, because the account store is asynchronous while provisioning is
 * synchronous.
 *
 * @module dsh-team-shell/shared-roots
 */

import { isAbsolute, normalize, resolve, sep } from 'node:path'

/** One validated entry of the deployment's `TEAM_SHARED_ROOTS` mapping. */
export interface SharedRootEntry {
  /** Absolute path, placeholder substituted and lexically resolved. */
  readonly path: string
  /** Account roles this root is granted to; an empty list means every role. */
  readonly roles: readonly string[]
  /** Whether the root is writable, or readable only. */
  readonly writable: boolean
}

/** The roots one account ends up with. */
export interface ResolvedSharedRoots {
  /** Absolute paths the account's sandbox may write. */
  readonly writable: readonly string[]
  /** Absolute paths the account's local reads may reach, including the writable ones. */
  readonly readable: readonly string[]
}

/** No granted roots — the state of every deployment that configures no mapping. */
export const NO_SHARED_ROOTS: ResolvedSharedRoots = { writable: [], readable: [] }

/** Placeholder a mapping entry uses instead of spelling the users root out. */
const USERS_ROOT_PLACEHOLDER = '<usersRoot>'

/** Whether `role` is among `roles`, treating an empty list as "every role". */
function roleMatches(roles: readonly string[], role: string): boolean {
  return roles.length === 0 || roles.includes(role)
}

/**
 * Whether a grant on `root` would disturb the mount shadow tree. A grant that
 * contains `shadowRoot` is bound over the sandbox's ephemeral temp mount and so
 * re-exposes every account's shadow directory; one inside the tree names a
 * mirror of a remote host rather than server data. Both are dropped.
 */
function disturbsShadowTree(root: string, shadowRoot: string): boolean {
  return root === shadowRoot || root.startsWith(`${shadowRoot}${sep}`) || shadowRoot.startsWith(`${root}${sep}`)
}

/**
 * Normalize one configured path: substitute the users-root placeholder, resolve
 * lexically, and drop a trailing separator so prefix comparisons see one
 * spelling.
 * @param raw - the configured path.
 * @param usersRoot - the deployment's users root, for the placeholder.
 * @returns the absolute path, or undefined when the entry is unusable.
 */
function normalizeEntryPath(raw: string, usersRoot: string): string | undefined {
  const substituted = raw.replaceAll(USERS_ROOT_PLACEHOLDER, usersRoot)
  if (!isAbsolute(substituted)) return undefined
  const normalized = normalize(resolve(substituted))
  if (normalized === sep) return undefined
  return normalized.replace(/[/\\]+$/, '')
}

/**
 * Parse and validate the deployment's shared-root mapping.
 *
 * Tolerant by design: a missing, unparsable, or malformed value resolves to no
 * grants at all. Provisioning must not fail because an operator mistyped this
 * one variable, and dropping a grant only ever removes a permission.
 *
 * @param raw - the raw `TEAM_SHARED_ROOTS` value (a JSON array), or undefined.
 * @param usersRoot - the deployment's users root, substituted for the placeholder.
 * @param shadowRoot - the mount shadow root; grants that disturb it are dropped.
 * @returns the validated entries, in configuration order.
 */
export function parseSharedRoots(raw: string | undefined, usersRoot: string, shadowRoot: string): SharedRootEntry[] {
  if (raw === undefined || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const shadow = normalize(resolve(shadowRoot))
  const entries: SharedRootEntry[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const candidate = item as { path?: unknown; roles?: unknown; write?: unknown }
    if (typeof candidate.path !== 'string' || candidate.path === '') continue
    const path = normalizeEntryPath(candidate.path, usersRoot)
    if (path === undefined || disturbsShadowTree(path, shadow)) continue
    const roles = Array.isArray(candidate.roles)
      ? candidate.roles.filter((role): role is string => typeof role === 'string')
      : []
    entries.push({ path, roles, writable: candidate.write !== false })
  }
  return entries
}

/**
 * The roots one account receives. The writable list is what the sandbox may
 * write; the readable list adds the readable-only entries, because a directory
 * the account may not write is still a path its tools must reach.
 *
 * Both lists are deduplicated: two entries may name one directory, and a
 * readable-only entry may repeat a writable one.
 * @param entries - the parsed mapping, from {@link parseSharedRoots}.
 * @param role - the account's role (`dsh_users.role`).
 * @returns the account's writable and readable root lists.
 */
export function resolveSharedRoots(entries: readonly SharedRootEntry[], role: string): ResolvedSharedRoots {
  const granted = entries.filter(entry => roleMatches(entry.roles, role))
  if (granted.length === 0) return NO_SHARED_ROOTS
  return {
    writable: [...new Set(granted.filter(entry => entry.writable).map(entry => entry.path))],
    readable: [...new Set(granted.map(entry => entry.path))],
  }
}
