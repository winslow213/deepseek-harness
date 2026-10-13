/** Localizable rejections shared by profile management operations. */
import type { PluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import type { IncompatiblePlugin, ManagementError } from './types.ts'

/** Expected management rejection; presentation belongs to the caller's locale. */
export class ManagementFailure extends Error {
  /** Code rendered by the caller's locale dictionary. */
  readonly code: ManagementError['code']
  /** The packages an `incompatible-version` rejection names. */
  readonly incompatible: IncompatiblePlugin[] | undefined
  /** Detail a code alone cannot carry: the spec refused, or the ceiling that was passed. */
  readonly detail: string | undefined
  /**
   * @param code Localizable management rejection.
   * @param incompatible Packages the running DSH version rejects, for `incompatible-version`.
   * @param detail What the code alone cannot say, for the operation's own diagnostic.
   */
  constructor(code: ManagementError['code'], incompatible?: IncompatiblePlugin[], detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.code = code
    this.incompatible = incompatible
    this.detail = detail
  }
}

/**
 * Drop the exemption status from an unexempted compatibility result.
 * @param issue Result whose exemption is not active.
 * @returns The package, runtime, and rejected peer ranges.
 */
export function incompatiblePlugin(issue: PluginCompatibility): IncompatiblePlugin {
  return { name: issue.name, version: issue.version, runtimeVersion: issue.runtimeVersion, peers: issue.peers }
}
