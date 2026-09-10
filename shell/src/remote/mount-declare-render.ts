/**
 * Pure text rendering for the mounted-workspace declaration. Kept free of
 * `@deepseek-ai/*` imports so the standalone `node:test` runner can exercise
 * it; `mount-declare.ts` (which runs inside a dsh instance) calls it with the
 * session cwd and the cached hub mount table.
 *
 * @module dsh-team-shell/mount-declare-render
 */

import type { MountRecord } from './hub.ts'
import { isShadowPath, translateShadowPath } from './shadow.ts'

/**
 * Render the mounted-workspace declaration for one assembly. Returns an empty
 * string when the cwd is absent, outside the shadow tree, or under a mount the
 * given user does not own, so local sessions get no added prose.
 * @param cwd - the session working directory (a shadow path for mounted sessions).
 * @param mounts - current mount records (from hub /api/mounts).
 * @param user - hub user id of this instance; only their mounts are declared.
 * @param shadowRoot - root holding every mount's shadow directory.
 * @returns the declaration paragraph, or '' when there is nothing to declare.
 */
export function renderMountedWorkspace(
  cwd: string | undefined,
  mounts: readonly MountRecord[],
  user: string,
  shadowRoot: string,
): string {
  if (cwd === undefined || cwd === '') return ''
  if (!isShadowPath(cwd, shadowRoot)) return ''
  const hit = translateShadowPath(cwd, mounts)
  if (hit === undefined || hit.user !== user) return ''
  const mine = mounts.filter(mount => mount.user === user)
  const lines = [
    'Your working directory is a mounted directory mirroring a remote host, not the server\'s own filesystem. Paths under it are paths on that host; run commands through that host\'s shell and read/write files relative to that host. Do not search the server\'s own home or workspace directories for this user\'s code.',
    'Mounted roots for your account (server shadow path → remote host root):',
  ]
  for (const mount of mine) {
    lines.push(`- ${mount.shadowPath} → ${mount.root} (agent ${mount.agentId})`)
  }
  lines.push(`Your current working directory ${cwd} maps to ${hit.mount.root} on agent ${hit.mount.agentId}.`)
  return lines.join('\n')
}
