/**
 * Shadow-directory lifecycle for mounted workspaces.
 *
 * A mounted workspace points at a REAL server directory (shadow) so dsh's
 * workspace create/attach/recovery checks (realpath + stat) pass. Directories
 * are created lazily — only when a user actually adopts a mount as a
 * workspace — and removed when the mount is unloaded, so the server never
 * accumulates directories for mounts nobody uses. The mount→shadow mapping
 * itself lives in hub memory (/api/mounts), never in a file.
 *
 * @module dsh-team-shell/remote-shadow
 */

import { mkdir, rm, stat } from 'node:fs/promises'
import { normalize, sep } from 'node:path'
import type { MountRecord } from './hub.ts'

/** Default root holding every shadow mount directory. */
export const DEFAULT_SHADOW_ROOT = '/var/lib/dsh-mounts'

/** Resolve the effective shadow root from an option or the default. */
export function shadowRootOf(shadowRoot: string | undefined): string {
  return shadowRoot === undefined || shadowRoot === '' ? DEFAULT_SHADOW_ROOT : shadowRoot
}

/**
 * Ensure a shadow directory exists (creating parents as needed). Idempotent.
 * @param shadowPath - the real server path of one mount shadow.
 * @returns the normalized absolute shadow path.
 */
export async function ensureShadowDir(shadowPath: string): Promise<string> {
  const target = normalize(shadowPath)
  await mkdir(target, { recursive: true })
  return target
}

/** Whether a shadow directory currently exists on the server. */
export async function shadowExists(shadowPath: string): Promise<boolean> {
  try {
    const info = await stat(normalize(shadowPath))
    return info.isDirectory()
  } catch {
    return false
  }
}

/**
 * Remove a shadow directory tree. Best-effort: a missing directory is a
 * success. Parent directories (the user/agent scaffolding) are left in place;
 * they are shared and recreated on demand.
 * @param shadowPath - the shadow directory to remove.
 * @returns whether anything was removed.
 */
export async function removeShadowDir(shadowPath: string): Promise<boolean> {
  const target = normalize(shadowPath)
  try {
    await rm(target, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** Whether an absolute server path lives inside the shadow root. */
export function isShadowPath(absolutePath: string, shadowRoot: string): boolean {
  const root = normalize(shadowRoot).replace(/\/+$/, '')
  const path = normalize(absolutePath)
  return path === root || path.startsWith(root + sep)
}

/** Relative portion of a path under the shadow root (no leading slash). */
export function shadowRelative(absolutePath: string, shadowRoot: string): string | undefined {
  const root = normalize(shadowRoot).replace(/\/+$/, '')
  const path = normalize(absolutePath)
  if (!isShadowPath(path, root)) return undefined
  const rel = path === root ? '' : path.slice(root.length + 1)
  return rel === '' ? undefined : rel
}

/** Result of translating a server shadow path into a remote agent request. */
export interface ShadowTranslation {
  /** Hub user whose agent serves the underlying root. */
  user: string
  /** Real path on the agent host the operation should target. */
  remotePath: string
  /** The matched mount. */
  mount: MountRecord
}

/**
 * Translate an absolute server path under the shadow root into the matching
 * agent's real path. The longest matching shadow directory wins, so a nested
 * mount shadows its parent for paths beneath it. The remainder is joined to
 * the agent root using the separator the root itself uses (POSIX `/` vs
 * Windows `\`), so a `D:\workspace` root receives `D:\workspace\sub\file`.
 * @param absolutePath - server-side path under some mount's shadow directory.
 * @param mounts - current mount records (from hub /api/mounts).
 * @returns the hub user + agent-side absolute path, or undefined when the path
 *   is not under any known shadow.
 */
export function translateShadowPath(absolutePath: string, mounts: readonly MountRecord[]): ShadowTranslation | undefined {
  const normalized = normalize(absolutePath)
  let best: { mount: MountRecord; depth: number } | undefined
  for (const mount of mounts) {
    const shadow = normalize(mount.shadowPath)
    if (normalized === shadow || normalized.startsWith(shadow + sep)) {
      const depth = shadow.split(sep).length
      if (best === undefined || depth > best.depth) {
        best = { mount, depth }
      }
    }
  }
  if (best === undefined) return undefined
  const { mount } = best
  const shadowNorm = normalize(mount.shadowPath)
  const relPosix = normalized.slice(shadowNorm.length).replace(/^[/\\]+/, '')
  // Preserve the agent-side separator: Windows roots use backslashes.
  const remoteSep = mount.root.includes('\\') ? '\\' : '/'
  const remotePath = relPosix === ''
    ? mount.root
    : `${mount.root.replace(/[\\/]+$/, '')}${remoteSep}${relPosix.replaceAll('/', remoteSep)}`
  return { user: mount.user, remotePath, mount }
}
