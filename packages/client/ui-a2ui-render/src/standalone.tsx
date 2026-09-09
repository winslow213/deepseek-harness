/**
 * Standalone A2UI page renderer for the dedicated popup window. It mounts a
 * minimal React root that draws the form or canvas page with no slot
 * dependency, and owns the popup run-time: every click resolves through
 * `invokeAction` into the single message the opener must act on, and every
 * opener reply folds through `reducePopupState` into one popup state.
 * @module @deepseek-ai/dsh-client-ui-a2ui/standalone
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { A2uiAction, A2uiPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import { A2uiCanvasPanel } from './A2uiCanvasPanel.tsx'
import { A2uiFormPanel, type FieldValue } from './A2uiFormPanel.tsx'
import type { A2uiTranslate } from './a2ui-chrome.tsx'
import { evaluateA2uiExpression } from './a2ui-expression.ts'
import {
  A2UI_POPUP_IDLE, completionToOptions, invokeAction, reducePopupState, selectOutcome,
  type A2uiExpressionEvaluator, type A2uiResolvedOption, type A2uiResolvedStep, type A2uiValues,
} from './a2ui-runtime.ts'
import type { A2uiOpenerMessage, A2uiPopupMessage } from './a2ui-wire.ts'
import { en, zh, type A2uiKey } from './locales.ts'
import css from './A2uiPanel.module.css'

/** Popup render options: the page to draw and its stable identity. */
export interface A2uiPopupOptions {
  /** Stable surface identity the submission correlates with. */
  readonly surfaceId: string
  /** The declarative page to render. */
  readonly page: A2uiPage
}

/** Read the persisted locale, defaulting to English. */
function readLocale(): 'en' | 'zh' {
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem('dsh.locale')
  return raw !== null && raw.startsWith('zh') ? 'zh' : 'en'
}

/** Build a `t` that substitutes `{param}` placeholders, mirroring the slot locale seat. */
function buildTranslate(locale: 'en' | 'zh'): A2uiTranslate {
  const dict = locale === 'zh' ? zh : en
  return (key: A2uiKey, params?: Record<string, string>) => {
    let text = dict[key]
    if (params !== undefined) {
      for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, value)
    }
    return text
  }
}

/** The restricted expression evaluator the local actions run through. */
const evaluateExpression: A2uiExpressionEvaluator = (expression, values) => {
  try {
    return evaluateA2uiExpression(expression, values as Parameters<typeof evaluateA2uiExpression>[1])
  } catch {
    return null
  }
}

/** The popup host: one reducer-owned runtime, posting resolved intents to the opener. */
function A2uiPopupHost({ surfaceId, page, t, opener }: {
  surfaceId: string
  page: A2uiPage
  t: A2uiTranslate
  opener: Window
}) {
  const [state, dispatch] = useReducer(reducePopupState, A2UI_POPUP_IDLE)
  const { busy, run, live, localResult, scriptResult, scriptError } = state
  const [patch, setPatch] = useState<Readonly<Record<string, FieldValue>> | null>(null)
  const [optionSets, setOptionSets] = useState<Record<string, readonly A2uiResolvedOption[]>>({})
  // The action whose outcome is still pending a possible write-back.
  const pendingActionRef = useRef<A2uiAction | null>(null)
  // optionsFrom action id -> owning select field name (static per page).
  const optionActionsRef = useRef<Map<string, string> | null>(null)
  if (optionActionsRef.current === null) {
    const map = new Map<string, string>()
    if (page.kind === 'form') {
      for (const field of page.fields) {
        if (field.optionsFrom !== undefined) map.set(field.optionsFrom, field.name)
      }
    }
    optionActionsRef.current = map
  }
  // data source name -> owning select field name (static per page).
  const sourceFieldsRef = useRef<Map<string, string> | null>(null)
  if (sourceFieldsRef.current === null) {
    const map = new Map<string, string>()
    if (page.kind === 'form') {
      for (const field of page.fields) {
        if (field.source !== undefined) map.set(field.source, field.name)
      }
    }
    sourceFieldsRef.current = map
  }
  const post = useCallback((message: A2uiPopupMessage): void => {
    opener.postMessage(message, location.origin)
  }, [opener])

  const onSubmit = useCallback((payload: Record<string, unknown>): void => {
    dispatch({ type: 'submit-sent' })
    const message: A2uiPopupMessage = { type: 'a2ui/submit', surfaceId, payload }
    post(message)
  }, [surfaceId, post])

  // Execute one resolved local step list: field writes become a batch patch,
  // `refresh` re-requests a source, and `stop` asks the opener to stop the run.
  const runLocalSteps = useCallback((steps: readonly A2uiResolvedStep[]): void => {
    const writes: Record<string, FieldValue> = {}
    for (const step of steps) {
      if (step.kind === 'set' || step.kind === 'append') {
        writes[step.field] = step.value === null ? '' : step.value
      } else if (step.kind === 'refresh') {
        const message: A2uiPopupMessage = { type: 'a2ui/data-request', surfaceId, source: step.source, args: {} }
        post(message)
      } else {
        const message: A2uiPopupMessage = { type: 'a2ui/stop', surfaceId, runId: run.runId }
        post(message)
      }
    }
    if (Object.keys(writes).length > 0) setPatch(writes)
  }, [surfaceId, post, run.runId])

  const onAction = useCallback((action: A2uiAction, values: Record<string, unknown>): void => {
    const invocation = invokeAction(action, values as A2uiValues, surfaceId, evaluateExpression, t('action.localDone'))
    switch (invocation.kind) {
      case 'expr':
        dispatch({ type: 'local-result', text: invocation.result })
        break
      case 'steps':
        runLocalSteps(invocation.steps)
        dispatch({ type: 'local-result', text: invocation.result })
        break
      case 'command':
        // The opener answers with runStarted (busy) and settles via runDone.
        post(invocation.message)
        break
      case 'script':
        pendingActionRef.current = action
        dispatch({ type: 'submit-sent' })
        post(invocation.message)
        break
      case 'model':
        dispatch({ type: 'submit-sent' })
        post(invocation.message)
        break
    }
  }, [surfaceId, post, t, runLocalSteps])

  const stopRun = useCallback((): void => {
    const current = state.run
    if (current.runId === null) return
    dispatch({ type: 'run-stop-requested' })
    const message: A2uiPopupMessage = { type: 'a2ui/runStop', runId: current.runId }
    post(message)
  }, [state.run, post])

  // Fire each declared optionsFrom action once on open so the page starts
  // with live options. The same runScript path a manual click uses.
  const runOptionSource = useCallback((action: A2uiAction): void => {
    pendingActionRef.current = action
    const invocation = invokeAction(action, {}, surfaceId, evaluateExpression, t('action.localDone'))
    if (invocation.kind === 'script') {
      dispatch({ type: 'submit-sent' })
      post(invocation.message)
    }
  }, [surfaceId, post, t])
  useEffect(() => {
    if (page.kind !== 'form') return
    const actions = page.actions ?? []
    for (const field of page.fields) {
      if (field.optionsFrom === undefined) continue
      const action = actions.find(candidate => candidate.id === field.optionsFrom)
      if (action !== undefined) runOptionSource(action)
    }
  }, [page, runOptionSource])

  // Request each host-backed data source once on open so the page starts with
  // live options. The opener answers with a2ui/data (or a2ui/data-failed).
  useEffect(() => {
    if (page.kind !== 'form') return
    for (const field of page.fields) {
      if (field.source === undefined) continue
      const message: A2uiPopupMessage = {
        type: 'a2ui/data-request',
        surfaceId,
        source: field.source,
        args: {},
      }
      post(message)
    }
  }, [page, surfaceId, post])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== location.origin || event.source !== opener) return
      const data = event.data as A2uiOpenerMessage | null
      if (data === null) return
      switch (data.type) {
        case 'a2ui/ack':
          dispatch({ type: 'ack' })
          break
        case 'a2ui/runStarted':
          dispatch({ type: 'run-started', runId: data.runId })
          break
        case 'a2ui/runChunk':
          dispatch({ type: 'run-chunk', output: data.output, running: data.running })
          break
        case 'a2ui/runDone':
          dispatch({ type: 'run-done', exitCode: data.exitCode })
          break
        case 'a2ui/runFailed':
          dispatch({ type: 'run-failed', message: data.message })
          break
        case 'a2ui/liveStarted':
          dispatch({ type: 'live-started' })
          break
        case 'a2ui/liveChunk':
          dispatch({ type: 'live-chunk', output: data.output })
          break
        case 'a2ui/liveDone':
          dispatch({ type: 'live-done' })
          break
        case 'a2ui/scriptResult': {
          const text = data.value === undefined ? '(no value)' : JSON.stringify(data.value)
          dispatch({ type: 'script-result', text })
          const optionField = optionActionsRef.current?.get(data.actionId)
          if (optionField !== undefined && data.value !== undefined) {
            const resolved = completionToOptions(data.value)
            setOptionSets(current => ({ ...current, [optionField]: resolved }))
          }
          const action = pendingActionRef.current
          const write = action?.write?.[0]
          if (write !== undefined && data.value !== undefined) {
            const selected = selectOutcome(data.value, write.from)
            if (typeof selected === 'string' || typeof selected === 'number' || typeof selected === 'boolean') {
              // A fresh object identity each time lets the panel apply it once.
              setPatch({ [write.field]: selected })
            }
          }
          pendingActionRef.current = null
          break
        }
        case 'a2ui/scriptFailed':
          dispatch({ type: 'script-failed', message: data.message })
          break
        case 'a2ui/data': {
          const field = sourceFieldsRef.current?.get(data.source)
          if (field !== undefined) {
            const resolved = completionToOptions(data.items)
            setOptionSets(current => ({ ...current, [field]: resolved }))
          }
          break
        }
        case 'a2ui/data-failed':
          // A source that cannot resolve degrades to an empty select rather
          // than failing the page; the opener already surfaced the error.
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [opener])

  const panel = page.kind === 'canvas'
    ? <A2uiCanvasPanel page={page} surfaceId={surfaceId} t={t} busy={busy} onSubmit={onSubmit}
      onAction={onAction} />
    : <A2uiFormPanel page={page} surfaceId={surfaceId} t={t} busy={busy} onSubmit={onSubmit}
      onAction={onAction} patch={patch} optionSets={optionSets} />

  const active = run.runId !== null || run.error !== null
  return (
    <>
      {panel}
      {localResult !== null && <p className={css.result} role="status">{localResult}</p>}
      {scriptResult !== null && <p className={css.result} role="status">⇒ {scriptResult}</p>}
      {scriptError !== null && <p className={css.error} role="alert">{scriptError}</p>}
      {active && (
        <div className={css.console} data-a2ui-console>
          <div className={css.consoleHeader}>
            <span className={css.consoleStatus}>{run.running ? '…' : run.error === null ? '✓' : '✕'}</span>
            {run.running && (
              <button type="button" className={css.consoleStop} onClick={stopRun}>{t('run.stop')}</button>
            )}
          </div>
          {run.error !== null && <p className={css.consoleError}>{run.error}</p>}
          <pre className={css.consoleBody}>{run.output || t('run.waiting')}</pre>
        </div>
      )}
      {live.active && (
        <div className={css.console} data-a2ui-live>
          <div className={css.consoleHeader}>
            <span className={css.consoleStatus}>{live.running ? '…' : '✓'}</span>
          </div>
          <pre className={css.consoleBody}>{live.output || t('run.waiting')}</pre>
        </div>
      )}
    </>
  )
}

/**
 * Mount the standalone A2UI page into a popup window's DOM node.
 * @param root - the popup document's mount node.
 * @param options - the page and surface identity to render.
 * @returns an unmount disposer.
 */
export function renderA2uiPopup(root: HTMLElement, options: A2uiPopupOptions): () => void {
  const opener = window.opener as Window | null
  if (opener === null) throw new Error('a2ui popup: no opener window')
  console.log('[a2ui] renderA2uiPopup', { surfaceId: options.surfaceId, kind: options.page.kind })
  const reactRoot = createRoot(root)
  reactRoot.render(
    <A2uiPopupHost surfaceId={options.surfaceId} page={options.page} t={buildTranslate(readLocale())} opener={opener} />,
  )
  return () => { reactRoot.unmount() }
}
