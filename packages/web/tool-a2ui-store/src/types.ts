/**
 * Client-safe type surface of the A2UI tool store: the durable file record
 * and the store capability contract. Types only — no host-side value imports
 * — so a Client compilation face can read the same declarations the Host
 * emits.
 * @module @deepseek-ai/dsh-tool-a2ui-store/types
 */

import type { A2uiPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Progress phase of one A2UI live-result stream. */
export type A2uiUpdatePhase = 'started' | 'delta' | 'finished' | 'aborted'

/**
 * Durable payload of one `a2ui/update` event: the bounded, replayable live
 * stream of a page-correlated run (a `command` action's output, or the
 * background jobs a `model` action spawns). Each `delta` carries only the text
 * produced since the previous event; `totalBytes` is the cumulative byte count
 * so the client can derive a throughput label. The stream is log-only UI
 * projection — the model never reads it, so the event stays off the surface.
 */
export interface A2uiUpdateData {
  /** Stable surface identity the live-result stream correlates with. */
  readonly surfaceId: string
  readonly phase: A2uiUpdatePhase
  /** Monotonic sequence within the surface's stream. */
  readonly seq: number
  /** Incremental text since the previous event (absent on `started`/settle). */
  readonly delta?: string
  /** Cumulative byte count of the stream so far. */
  readonly totalBytes?: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Bounded, replayable live-result stream of one A2UI surface's correlated run. */
    'a2ui/update': A2uiUpdateData
  }
}

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
  /** Owning session: supplies the workspace workdir and receives `a2ui/update` events. */
  readonly sessionId: SessionId
  /** Stable surface identity the live-result events correlate with. */
  readonly surfaceId: string
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

/** Granted binding member a `script` action may call. */
export type A2uiScriptBinding = 'fetch' | 'text'

/** Request to run one `script`-action program on the controlled code runtime. */
export interface A2uiRunScriptRequest {
  /** The async program body. */
  readonly program: string
  /** Granted `a2ui.*` member names the program may call. */
  readonly binds: readonly A2uiScriptBinding[]
  /** Collected field values. */
  readonly fields: A2uiRunFieldValues
}

/** A JSON value a script completion may carry across the wire. */
export type A2uiScriptJson =
  | null | boolean | number | string
  | readonly A2uiScriptJson[]
  | { readonly [key: string]: A2uiScriptJson }

/** One completed `script` run. */
export interface A2uiRunScriptValue {
  /** The program's completion value (JSON), when it completed. */
  readonly value?: A2uiScriptJson
  /** Ordered log lines the program emitted. */
  readonly logs: readonly string[]
  /** Failure detail when the run did not complete. */
  readonly error?: { readonly kind: string; readonly message: string }
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

/** Request to read a live-result stream's output since the previous read. */
export interface A2uiLiveReadRequest {
  readonly surfaceId: string
}

/** One live-result read: the delta since the previous read plus state. */
export interface A2uiLiveReadValue {
  /** Output produced since the previous read (empty when none). */
  readonly output: string
  /** Whether the job is still running. */
  readonly running: boolean
  /** Whether the stream reached a terminal phase (a final `finished`/`aborted`). */
  readonly settled: boolean
}

/**
 * A name is a single safe file stem: no separators, no `.`/`..`, no control bytes.
 * @param name - the candidate tool name.
 * @returns whether the name is safe to use as a file stem.
 */
export function isSafeA2uiToolName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && !/[/\\]/.test(name) && name !== '.' && name !== '..' && /^[\w.-]+$/.test(name)
}
