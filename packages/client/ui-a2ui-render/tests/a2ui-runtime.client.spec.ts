/** Behavior of the A2UI runtime: action → invocation routing and the popup state reducer. */

import { describe, expect, it } from 'vitest'
import {
  A2UI_POPUP_IDLE, invokeAction, reducePopupState,
  type A2uiPopupAction, type A2uiValues,
} from '../src/a2ui-runtime.ts'

const SURFACE = 'a2ui-1'

const evaluate = (expression: string, values: A2uiValues): string | number | boolean | null => {
  // A stand-in for the real restricted evaluator: resolves {name} references.
  return expression.replace(/\{(\w+)\}/g, (_m, name: string) => String(values[name] ?? ''))
}

describe('invokeAction', () => {
  it('routes a command action to a2ui/run carrying the action and collected values', () => {
    const action = { id: 'go', label: 'Run', execution: 'command', command: 'echo {note}' }
    const inv = invokeAction(action, { note: 'hi' }, SURFACE, evaluate, 'Done')
    expect(inv).toEqual({
      kind: 'command',
      message: { type: 'a2ui/run', surfaceId: SURFACE, action, values: { note: 'hi' } },
    })
  })

  it('routes a model action to a2ui/action by default when execution is absent', () => {
    const action = { id: 'go', label: 'Ask', tool: 'run_tool', instruction: 'do it' }
    const inv = invokeAction(action, { note: 'hi' }, SURFACE, evaluate, 'Done')
    expect(inv.kind).toBe('model')
    if (inv.kind !== 'model') throw new Error('expected model')
    expect(inv.message).toMatchObject({ type: 'a2ui/action', surfaceId: SURFACE, action })
  })

  it('evaluates a local action result expression to text', () => {
    const action = { id: 'calc', label: 'Calc', execution: 'local', result: 'prefix-{note}' }
    const inv = invokeAction(action, { note: 'abc' }, SURFACE, evaluate, 'Done')
    expect(inv).toEqual({ kind: 'expr', result: 'prefix-abc' })
  })

  it('falls back to the done label when a local action has no result', () => {
    const action = { id: 'nop', label: 'Nop', execution: 'local' }
    expect(invokeAction(action, {}, SURFACE, evaluate, 'Done')).toEqual({ kind: 'expr', result: 'Done' })
  })
})

describe('reducePopupState', () => {
  it('idle has nothing in flight', () => {
    expect(A2UI_POPUP_IDLE).toEqual({ busy: false, run: expect.any(Object), localResult: null })
  })

  it('a submission marks busy and an ack clears it', () => {
    let state = reducePopupState(A2UI_POPUP_IDLE, { type: 'submit-sent' })
    expect(state.busy).toBe(true)
    state = reducePopupState(state, { type: 'ack' })
    expect(state.busy).toBe(false)
  })

  it('walks a command run through start → chunk → done', () => {
    const actions: A2uiPopupAction[] = [
      { type: 'run-started', runId: 'r1' },
      { type: 'run-chunk', output: 'one\n', running: true },
      { type: 'run-chunk', output: 'two\n', running: false },
      { type: 'run-done', exitCode: 0 },
    ]
    const final = actions.reduce(reducePopupState, A2UI_POPUP_IDLE)
    expect(final.busy).toBe(false)
    expect(final.run.runId).toBe('r1')
    expect(final.run.output).toBe('one\ntwo\n')
    expect(final.run.running).toBe(false)
    expect(final.run.settled).toBe(true)
    expect(final.run.exitCode).toBe(0)
    expect(final.run.error).toBeNull()
  })

  it('surfaces a run failure and keeps the partial output', () => {
    const state = [
      { type: 'run-started', runId: 'r1' },
      { type: 'run-chunk', output: 'boot\n', running: true },
      { type: 'run-failed', message: 'no shell mounted' },
    ].reduce(reducePopupState, A2UI_POPUP_IDLE)
    expect(state.busy).toBe(false)
    expect(state.run.error).toBe('no shell mounted')
    expect(state.run.output).toBe('boot\n')
    expect(state.run.settled).toBe(true)
  })

  it('records a stop request as no longer running', () => {
    const state = reducePopupState(
      reducePopupState(A2UI_POPUP_IDLE, { type: 'run-started', runId: 'r1' }),
      { type: 'run-stop-requested' },
    )
    expect(state.run.running).toBe(false)
  })

  it('sets and clears the local result', () => {
    let state = reducePopupState(A2UI_POPUP_IDLE, { type: 'local-result', text: 'hi' })
    expect(state.localResult).toBe('hi')
    state = reducePopupState(state, { type: 'local-result', text: null })
    expect(state.localResult).toBeNull()
  })
})
