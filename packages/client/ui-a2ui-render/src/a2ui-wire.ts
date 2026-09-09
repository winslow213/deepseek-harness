/**
 * A2UI popup wire protocol and message serializers, shared by the main-window
 * launcher and the standalone popup. Pure functions and types only — no React
 * and no host-side imports — so both bundle channels include it independently.
 * @module @deepseek-ai/dsh-client-ui-a2ui/wire
 */

import type { A2uiAction, A2uiFieldOption, A2uiPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'

/** Popup → opener message: readiness, submission, an action trigger, a command run, a script run, a source request, or a stop. */
export type A2uiPopupMessage =
  | { readonly type: 'a2ui/ready'; readonly surfaceId: string }
  | { readonly type: 'a2ui/submit'; readonly surfaceId: string; readonly payload: Record<string, unknown> }
  | { readonly type: 'a2ui/action'; readonly surfaceId: string; readonly action: A2uiAction; readonly values: Record<string, unknown> }
  | { readonly type: 'a2ui/run'; readonly surfaceId: string; readonly action: A2uiAction; readonly values: Record<string, unknown> }
  | { readonly type: 'a2ui/runScript'; readonly surfaceId: string; readonly action: A2uiAction; readonly values: Record<string, unknown> }
  | { readonly type: 'a2ui/data-request'; readonly surfaceId: string; readonly source: string; readonly args: Record<string, unknown> }
  | { readonly type: 'a2ui/runStop'; readonly runId: string }

/** Opener → popup message: the page to render, acknowledgements, source data, or command-run progress. */
export type A2uiOpenerMessage =
  | { readonly type: 'a2ui/init'; readonly surfaceId: string; readonly page: A2uiPage }
  | { readonly type: 'a2ui/ack' }
  | { readonly type: 'a2ui/data'; readonly surfaceId: string; readonly source: string; readonly items: readonly A2uiFieldOption[] }
  | { readonly type: 'a2ui/data-failed'; readonly surfaceId: string; readonly source: string; readonly message: string }
  | { readonly type: 'a2ui/runStarted'; readonly runId: string; readonly ok: true }
  | { readonly type: 'a2ui/runFailed'; readonly message: string; readonly ok: false }
  | { readonly type: 'a2ui/runChunk'; readonly runId: string; readonly output: string; readonly running: boolean }
  | { readonly type: 'a2ui/runDone'; readonly runId: string; readonly exitCode: number | null }
  | { readonly type: 'a2ui/scriptResult'; readonly ok: true; readonly actionId: string; readonly value?: unknown; readonly logs?: readonly string[] }
  | { readonly type: 'a2ui/scriptFailed'; readonly actionId?: string; readonly message: string; readonly ok: false }

/** Progress of one command run as the popup renders it. */
export interface A2uiRunState {
  readonly runId: string | null
  /** Output accumulated since the run started. */
  readonly output: string
  /** Whether the process is still running. */
  readonly running: boolean
  /** Whether the run has settled (finished or failed to start). */
  readonly settled: boolean
  /** Exit code once settled from a real run. */
  readonly exitCode: number | null
  /** Failure message when the host refused the run. */
  readonly error: string | null
}

/** The idle command-run state before any command action runs. */
export const A2UI_RUN_IDLE: A2uiRunState = {
  runId: null, output: '', running: false, settled: false, exitCode: null, error: null,
}

/**
 * Serialize one submission as an ordinary user message the model receives:
 * a stable `surfaceId` plus the kind-specific payload (`values` for a form,
 * `graph` for a canvas).
 * @param surfaceId - the durable surface identity.
 * @param payload - the collected values or the arranged graph.
 * @returns the JSON message text.
 */
export function a2uiSubmitMessage(surfaceId: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ a2uiSubmit: { surfaceId, ...payload } })
}

/**
 * Serialize one model-mode action trigger as an ordinary user message the
 * model receives: the stable `surfaceId`, the action's id and target tool, its
 * instruction, and the collected values.
 * @param surfaceId - the durable surface identity.
 * @param action - the triggered action.
 * @param values - the collected values (the tool's arguments).
 * @returns the JSON message text.
 */
export function a2uiActionMessage(surfaceId: string, action: A2uiAction, values: Record<string, unknown>): string {
  return JSON.stringify({
    a2uiAction: { surfaceId, actionId: action.id, tool: action.tool, instruction: action.instruction, values },
  })
}
