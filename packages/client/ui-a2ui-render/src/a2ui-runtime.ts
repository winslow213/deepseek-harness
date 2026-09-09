/**
 * Pure A2UI run-time: turns one user gesture into the single message the
 * opener must act on, and folds every opener reply into one popup state.
 *
 * The page vocabulary is deliberately small ([expression grammar]
 * /types.ts), so a click resolves to one of exactly three intents:
 * `expr` stays in the browser (the local result text), `command` asks the
 * opener to run a host shell command whose output streams back, and `model`
 * asks the opener to hand the collected values to the agent. Keep this
 * module free of React and of host imports so the decision logic is a
 * plain function a unit test can drive.
 */

import type { A2uiAction } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import type { A2uiPopupMessage, A2uiRunState } from './a2ui-wire.ts'
import { A2UI_RUN_IDLE } from './a2ui-wire.ts'
import { A2UI_LIVE_IDLE, type A2uiLiveState } from './a2ui-wire.ts'

/** A value field/expression may hold. */
export type A2uiValue = string | number | boolean | null

/** Collected values one action click carries. */
export type A2uiValues = Readonly<Record<string, A2uiValue>>

/**
 * What one action click means. The renderer performs the local side (running
 * the expression and showing its text) and posts the message side to the
 * opener; it never routes `command` and `model` differently beyond this.
 */
export type A2uiInvocation =
  | { readonly kind: 'expr'; readonly result: string | null }
  | { readonly kind: 'command'; readonly message: A2uiPopupMessage }
  | { readonly kind: 'script'; readonly message: A2uiPopupMessage }
  | { readonly kind: 'model'; readonly message: A2uiPopupMessage }

/** Evaluate one restricted expression over the collected values. */
export type A2uiExpressionEvaluator = (expression: string, values: A2uiValues) => A2uiValue

/** Default behavior: an action without an execution mode is a model action. */
const DEFAULT_EXECUTION: NonNullable<A2uiAction['execution']> = 'model'

/**
 * Resolve one action click against the collected values into the intent the
 * popup should carry out. A `command`/`model` action yields the wire message
 * to post; an `expr` action yields the local result text computed in-browser.
 * @param action - the triggered declarative action.
 * @param values - the collected, validated field values.
 * @param surfaceId - the stable surface identity the message correlates with.
 * @param evaluate - the restricted expression evaluator (`local` results).
 * @param localDone - the locale text shown when a local action has no result.
 * @returns the single invocation to perform.
 */
export function invokeAction(
  action: A2uiAction,
  values: A2uiValues,
  surfaceId: string,
  evaluate: A2uiExpressionEvaluator,
  localDone: string,
): A2uiInvocation {
  const execution = action.execution ?? DEFAULT_EXECUTION
  switch (execution) {
    case 'local': {
      const source = action.result
      if (source === undefined || source.trim().length === 0) {
        return { kind: 'expr', result: localDone }
      }
      const evaluated = evaluate(source, values)
      return { kind: 'expr', result: evaluated === null ? null : String(evaluated) }
    }
    case 'command': {
      const message: A2uiPopupMessage = {
        type: 'a2ui/run',
        surfaceId,
        action,
        values: values as Record<string, unknown>,
      }
      return { kind: 'command', message }
    }
    case 'script': {
      const message: A2uiPopupMessage = {
        type: 'a2ui/runScript',
        surfaceId,
        action,
        values: values as Record<string, unknown>,
      }
      return { kind: 'script', message }
    }
    case 'model': {
      const message: A2uiPopupMessage = { type: 'a2ui/action', surfaceId, action, values: values as Record<string, unknown> }
      return { kind: 'model', message }
    }
    default: {
      const _exhaustive: never = execution
      void _exhaustive
      const message: A2uiPopupMessage = { type: 'a2ui/action', surfaceId, action, values: values as Record<string, unknown> }
      return { kind: 'model', message }
    }
  }
}

/**
 * The popup's full runtime state: whether a submission/action is in flight,
 * the most recent command-run progress, and the latest local result text.
 * This is the single projection every opener reply mutates.
 */
export interface A2uiPopupState {
  /** A submission or model/command action is awaiting the opener. */
  readonly busy: boolean
  /** The current command run (idle until a `command` action starts). */
  readonly run: A2uiRunState
  /** The live-result pane for a `model`-action background job stream. */
  readonly live: A2uiLiveState
  /** The latest `local` action's result text, if any. */
  readonly localResult: string | null
  /** The latest `script` action's completion (JSON) text, if any. */
  readonly scriptResult: string | null
  /** Failure message of the latest `script`/other action, if any. */
  readonly scriptError: string | null
}

/** The idle popup state before any action. */
export const A2UI_POPUP_IDLE: A2uiPopupState = {
  busy: false,
  run: A2UI_RUN_IDLE,
  live: A2UI_LIVE_IDLE,
  localResult: null,
  scriptResult: null,
  scriptError: null,
}

/** One state-transition action the popup dispatches. */
export type A2uiPopupAction =
  | { readonly type: 'submit-sent' }
  | { readonly type: 'ack' }
  | { readonly type: 'run-started'; readonly runId: string }
  | { readonly type: 'run-chunk'; readonly output: string; readonly running: boolean }
  | { readonly type: 'run-done'; readonly exitCode: number | null }
  | { readonly type: 'run-failed'; readonly message: string }
  | { readonly type: 'run-stop-requested' }
  | { readonly type: 'live-started' }
  | { readonly type: 'live-chunk'; readonly output: string }
  | { readonly type: 'live-done' }
  | { readonly type: 'local-result'; readonly text: string | null }
  | { readonly type: 'script-result'; readonly text: string }
  | { readonly type: 'script-failed'; readonly message: string }

/**
 * Fold one popup event into the popup state. Pure and synchronous so the
 * message handler stays a thin `dispatch` call and every transition is a
 * unit-testable projection.
 * @param state - the current popup state.
 * @param event - the event to fold in.
 * @returns the next popup state.
 */
export function reducePopupState(state: A2uiPopupState, event: A2uiPopupAction): A2uiPopupState {
  switch (event.type) {
    case 'submit-sent':
      return { ...state, busy: true }
    case 'ack':
      return { ...state, busy: false }
    case 'run-started':
      return {
        ...state,
        busy: true,
        run: { ...state.run, runId: event.runId, running: true, settled: false, error: null },
      }
    case 'run-chunk':
      return { ...state, run: { ...state.run, output: state.run.output + event.output, running: event.running } }
    case 'run-done':
      return { ...state, busy: false, run: { ...state.run, running: false, settled: true, exitCode: event.exitCode } }
    case 'run-failed':
      return {
        ...state,
        busy: false,
        run: { ...state.run, error: event.message, running: false, settled: true },
      }
    case 'run-stop-requested':
      return { ...state, run: { ...state.run, running: false } }
    case 'live-started':
      return { ...state, live: { active: true, output: '', running: true, settled: false } }
    case 'live-chunk':
      return { ...state, live: { ...state.live, output: state.live.output + event.output } }
    case 'live-done':
      return { ...state, live: { ...state.live, running: false, settled: true } }
    case 'script-result':
      return { ...state, busy: false, scriptResult: event.text, scriptError: null }
    case 'script-failed':
      return { ...state, busy: false, scriptError: event.message }
    case 'local-result':
      return { ...state, localResult: event.text }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

/** The opener messages the popup posts; the dispatch side mirrors `reducePopupState`. */
export type A2uiDispatchMessage = A2uiPopupMessage | { readonly type: 'a2ui/ack-sent' }

/** One JSON-ish value a selector may traverse. */
type Selectable = unknown

/**
 * Resolve a dotted selector against an outcome value. `value` addresses the
 * whole outcome; `value.a.b` a nested member. Returns `undefined` when the
 * path does not exist or a segment is not an object/array.
 * @param outcome - the outcome value (script completion or command summary).
 * @param selector - the dotted path, starting at the root name (`value`).
 * @returns the addressed member, or `undefined` when absent.
 */
export function selectOutcome(outcome: Selectable, selector: string): unknown {
  if (selector === 'value' || selector === '') return outcome
  if (!selector.startsWith('value.')) return undefined
  const segments = selector.slice('value.'.length).split('.')
  let current: Selectable = outcome
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** A resolved select option. */
export interface A2uiResolvedOption {
  readonly label: string
  readonly value: string
}

/**
 * Convert one script completion into select options. Accepts either a bare
 * array of `{label,value}` records or `{ items: [...] }`. Invalid entries
 * are skipped; a non-array-shaped completion yields `[]` so a page degrades
 * to an empty select rather than failing.
 * @param completion - the script completion value.
 * @returns the resolved options (label/value strings).
 */
export function completionToOptions(completion: unknown): A2uiResolvedOption[] {
  const source = Array.isArray(completion) ? completion
    : completion !== null && typeof completion === 'object' && Array.isArray((completion as { items?: unknown }).items)
      ? (completion as { items: unknown[] }).items
      : []
  const options: A2uiResolvedOption[] = []
  for (const item of source) {
    if (item === null || typeof item !== 'object') continue
    const record = item as { label?: unknown; value?: unknown }
    if (typeof record.label !== 'string' || typeof record.value !== 'string') continue
    options.push({ label: record.label, value: record.value })
  }
  return options
}
