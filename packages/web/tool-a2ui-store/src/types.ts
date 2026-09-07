/**
 * Client-safe type surface of the A2UI tool store: the durable file record
 * and the store capability contract. Types only — no host-side value imports
 * — so a Client compilation face can read the same declarations the Host
 * emits.
 * @module @deepseek-ai/dsh-tool-a2ui-store/types
 */

import type { A2uiPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'

/** One saved A2UI tool: a page definition persisted under a stable name. */
export interface A2uiToolRecord {
  /** Stable tool name; also the file stem under the store directory. */
  readonly name: string
  /** The canonical page definition (DSL + field logic + actions). */
  readonly page: A2uiPage
  /** ISO-8601 timestamp of the last save. */
  readonly savedAt: string
}

/** The store directory's default location under the harness home. */
export const A2UI_TOOLS_DIR = 'a2ui-tools'

/** A name is a single safe file stem: no separators, no `.`/`..`, no control bytes. */
export function isSafeA2uiToolName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && !/[/\\]/.test(name) && name !== '.' && name !== '..' && /^[\w.-]+$/.test(name)
}
