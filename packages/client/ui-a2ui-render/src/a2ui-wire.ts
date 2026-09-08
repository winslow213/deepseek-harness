/**
 * A2UI popup wire protocol and message serializers, shared by the main-window
 * launcher and the standalone popup. Pure functions and types only — no React
 * and no host-side imports — so both bundle channels include it independently.
 * @module @deepseek-ai/dsh-client-ui-a2ui/wire
 */

import type { A2uiAction, A2uiPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'

/** Popup → opener message: a readiness signal, a submission, or a model action. */
export type A2uiPopupMessage =
  | { readonly type: 'a2ui/ready' }
  | { readonly type: 'a2ui/submit'; readonly surfaceId: string; readonly payload: Record<string, unknown> }
  | { readonly type: 'a2ui/action'; readonly surfaceId: string; readonly action: A2uiAction; readonly values: Record<string, unknown> }

/** Opener → popup message: the page to render, or an acknowledgement after a submit. */
export type A2uiOpenerMessage =
  | { readonly type: 'a2ui/init'; readonly surfaceId: string; readonly page: A2uiPage }
  | { readonly type: 'a2ui/ack' }

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
