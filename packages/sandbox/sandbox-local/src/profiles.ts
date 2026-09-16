/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { readShield, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/** Every ancestor directory of `path`, outermost first, excluding `path` itself. */
function ancestorsOf(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(0, -1).map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)
}

/**
 * Build the bwrap profile arguments for one file-effect policy.
 *
 * A read shield mounts an empty `tmpfs` over each denied root and then re-binds
 * the allowed subtrees back on top. bwrap applies mounts in argument order and
 * the last one to touch a path wins, so the shield is emitted BEFORE the mode's
 * own mounts: a workspace that lives inside a denied root must be bound back
 * writable afterwards, or the shield's read-only re-exposure would silently
 * turn the writable workspace read-only. For the same reason every intermediate
 * directory on the way to an allowed subtree needs its own `--dir` — `--tmpfs`
 * leaves a bare mount point where the parents used to be.
 *
 * @param policy - file-effect and read-boundary policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  const { denied, allowed } = readShield(policy)
  for (const root of denied) {
    args.push('--tmpfs', root)
    for (const allowedRoot of allowed) {
      if (!allowedRoot.startsWith(`${root}/`)) continue
      for (const ancestor of ancestorsOf(allowedRoot)) {
        args.push('--dir', ancestor)
      }
      args.push('--ro-bind', allowedRoot, allowedRoot)
    }
  }
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

/**
 * System directories a confined command needs to read to run at all: the
 * dynamic loader, the shell and coreutils, the toolchain under `/usr/local`,
 * and the kernel-facing `/proc`, `/dev`, `/run`. Landlock grants are an
 * allow-list, so this list IS the read policy once a read shield is active —
 * it deliberately names no home directory, which is what leaves the denied
 * roots (per-account homes under a shared users root) unmasked-free.
 *
 * Omitting a directory the toolchain actually needs does not weaken the mask;
 * it breaks the command loudly, which is the failure mode the Landlock e2e
 * covers.
 */
const LANDLOCK_SYSTEM_READ_ROOTS = ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc', '/opt', '/proc', '/dev', '/run'] as const

/**
 * Build the Landlock launcher grants for one file-effect policy.
 *
 * Without a read shield the grant stays the historical `readOnly: ['/']` —
 * Landlock expresses allow-lists only, so it cannot subtract a path from a
 * blanket grant. With one, the blanket grant is replaced by the system roots
 * plus the re-exposed subtrees, which is the only spelling that actually hides
 * the denied roots.
 *
 * @param policy - file-effect and read-boundary policy to express as Landlock grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  const { denied, allowed } = readShield(policy)
  const readOnly = denied.length === 0
    ? ['/']
    : [...new Set([...LANDLOCK_SYSTEM_READ_ROOTS, ...allowed])]
  return landlockGrantArgs({ readOnly, readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart; read shielding comes
 * from the shared {@link readShield} helper for the same reason.
 * @param policy - file-effect and read-boundary policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  // Seatbelt resolves competing rules by taking the LAST match, so the broad
  // read denial must come before the re-exposure of the tenant's own subtree.
  const { denied, allowed } = readShield(policy)
  if (denied.length > 0) {
    forms.push(`(deny file-read* ${denied.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  if (allowed.length > 0) {
    forms.push(`(allow file-read* ${allowed.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  return ['-p', forms.join(' ')]
}
