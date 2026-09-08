/**
 * Client-safe type surface of the A2UI tool store: the durable file record
 * and the store capability contract. Types only — no host-side value imports
 * — so a Client compilation face can read the same declarations the Host
 * emits.
 * @module @deepseek-ai/dsh-tool-a2ui-store/types
 */

import type { A2uiPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** One saved A2UI tool: a page definition persisted under a stable name. */
export interface A2uiToolRecord {
  /** Stable tool name; also the file stem under the store directory. */
  readonly name: string
  /** The canonical page definition (DSL + field logic + actions). */
  readonly page: A2uiPage
  /** ISO-8601 timestamp of the last save. */
  readonly savedAt: string
}

/** One saved tool's wire record. */
export type A2uiToolWire = A2uiToolRecord

/** Response for the saved-tool list. */
export interface A2uiStoreListValue {
  readonly tools: readonly A2uiToolWire[]
}

/** Request to re-render one saved tool into the addressed session. */
export interface A2uiStoreOpenRequest {
  readonly sessionId: SessionId
  readonly name: string
}

/** Response after a saved tool is re-rendered. */
export interface A2uiStoreOpenValue {
  readonly surfaceId: string
  readonly name: string
}

/** Request to delete one saved tool. */
export interface A2uiStoreDeleteRequest {
  readonly name: string
}

/** Response after deleting one saved tool. */
export interface A2uiStoreDeleteValue {
  readonly removed: boolean
}

/** The store directory's default location under the harness home. */
export const A2UI_TOOLS_DIR = 'a2ui-tools'

/** Collected form values a `command` action passes to the host runner. */
export type A2uiRunFieldValues = Readonly<Record<string, string | number | boolean | null>>

/** Request to start one `command`-action run. */
export interface A2uiRunStartRequest {
  /** The `{fieldName}` command template to fill and execute. */
  readonly command: string
  /** Collected field values the template substitutes. */
  readonly fields: A2uiRunFieldValues
  /** Run bound in milliseconds; absent uses the host shell default and cap. */
  readonly timeoutMs?: number
}

/** Response after a run starts. */
export interface A2uiRunStartValue {
  /** Opaque run identity for later reads and stops. */
  readonly runId: string
}

/** Request to read the output produced since the previous read. */
export interface A2uiRunReadRequest {
  readonly runId: string
}

/** One consuming read: the delta since the previous read plus process state. */
export interface A2uiRunReadValue {
  readonly runId: string
  /** Monotonic chunk sequence; grows by one per read. */
  readonly seq: number
  /** Text produced since the previous read (empty when none). */
  readonly output: string
  /** Whether the process is still running. */
  readonly running: boolean
  /** Exit code once finished; null while running or signal-killed. */
  readonly exitCode: number | null
  /** True when truncation dropped bytes the delta cannot include. */
  readonly lossy: boolean
}

/** Request to stop one run's process group. */
export interface A2uiRunStopRequest {
  readonly runId: string
}

/** Response after requesting a stop. */
export interface A2uiRunStopValue {
  readonly runId: string
  /** True when a live process was asked to terminate; false if already done. */
  readonly requested: boolean
}

/**
 * A name is a single safe file stem: no separators, no `.`/`..`, no control bytes.
 * @param name - the candidate tool name.
 * @returns whether the name is safe to use as a file stem.
 */
export function isSafeA2uiToolName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && !/[/\\]/.test(name) && name !== '.' && name !== '..' && /^[\w.-]+$/.test(name)
}
