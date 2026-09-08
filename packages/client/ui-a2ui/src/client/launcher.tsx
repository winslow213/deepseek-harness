/**
 * The in-transcript launcher for one model-authored A2UI page. Instead of
 * rendering the form or canvas inline, the node shows a compact card whose
 * button opens the page in a dedicated popup window. The launcher owns the
 * popup handshake: it posts the page once the popup signals readiness, and
 * forwards the popup's submissions and model actions into the chat input
 * machine (`inputActions`) exactly as the inline panel used to.
 */

import { useEffect, useRef, useState } from 'react'
import type { A2uiAction } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the popup wire protocol lives in the zero-cordis render library,
// so the launcher and the standalone popup share one message vocabulary
// without dragging the renderer (or a second module-table row) across the
// channel boundary.
import type { A2uiOpenerMessage, A2uiPopupMessage } from '@deepseek-ai/dsh-client-ui-a2ui-render'
import css from './A2uiPanel.module.css'

/** Keyed Chat renderer props for one model-opened A2UI page launcher. */
export type A2uiLauncherProps =
  PropsRuntime<'conversation.chat.node', 'a2ui-surface'>
  & PropsLocale<'a2ui'>

/** The popup URL served by the web frontend's dedicated A2UI entry. */
const A2UI_POPUP_PATH = '/a2ui.html'

/**
 * The surface most recently mounted across this document. Reopening a
 * transcript re-mounts every historical launcher, so auto-open must fire once
 * for the newest surface only — the last `surfaceId` recorded after the
 * deferred timer settles.
 */
let lastAutoOpenKey: string | null = null

/** Serialize one submission as an ordinary user message the model receives. */
function a2uiSubmitMessage(surfaceId: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ a2uiSubmit: { surfaceId, ...payload } })
}

/** Serialize one model-mode action trigger as an ordinary user message. */
function a2uiActionMessage(surfaceId: string, action: A2uiAction, values: Record<string, unknown>): string {
  return JSON.stringify({
    a2uiAction: { surfaceId, actionId: action.id, tool: action.tool, instruction: action.instruction, values },
  })
}

/**
 * Render the launcher card and manage its popup window.
 * @param props - the keyed Chat slot props (node data, input machine, locale).
 */
export function A2uiLauncher({ node, inputActions, t }: A2uiLauncherProps) {
  const { page, surfaceId } = node.data
  const [blocked, setBlocked] = useState(false)
  const popupRef = useRef<Window | null>(null)

  useEffect(() => {
    console.log('[a2ui] launcher mounted', { surfaceId, kind: page.kind, origin: location.origin })
    return () => { console.log('[a2ui] launcher unmounted', surfaceId) }
  }, [surfaceId, page.kind])

  // Auto-open the popup for the newest mounted surface. When the sidebar's
  // open gesture has already opened the same named window, `window.open`
  // returns the existing window reference instead of a new one (no user
  // activation needed), so the launcher "adopts" it and the ready handshake
  // below completes the handoff. Only the last surface fires, so replaying a
  // transcript with many historical launchers opens at most one window.
  useEffect(() => {
    const key = surfaceId
    lastAutoOpenKey = key
    const timer = setTimeout(() => {
      if (lastAutoOpenKey !== key) return
      const win = window.open(A2UI_POPUP_PATH, `a2ui-${surfaceId}`, 'popup=yes,width=920,height=760')
      console.log('[a2ui] auto-open', { surfaceId, opened: win !== null })
      if (win !== null) popupRef.current = win
    }, 200)
    return () => { clearTimeout(timer) }
  }, [surfaceId])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== location.origin) {
        console.warn('[a2ui] ignored message: origin mismatch', { got: event.origin, want: location.origin })
        return
      }
      const popup = popupRef.current
      if (popup === null || event.source !== popup) {
        console.warn('[a2ui] ignored message: not from tracked popup', { hasPopup: popup !== null })
        return
      }
      const data = event.data as A2uiPopupMessage | undefined
      if (data === undefined) return
      console.log('[a2ui] opener received', data.type)
      if (data.type === 'a2ui/ready') {
        const init: A2uiOpenerMessage = { type: 'a2ui/init', surfaceId, page }
        popup.postMessage(init, location.origin)
        console.log('[a2ui] sent init to popup', surfaceId)
      } else if (data.type === 'a2ui/submit') {
        inputActions.setDraft(a2uiSubmitMessage(surfaceId, data.payload))
        inputActions.submit()
        const ack: A2uiOpenerMessage = { type: 'a2ui/ack' }
        popup.postMessage(ack, location.origin)
      } else {
        inputActions.setDraft(a2uiActionMessage(surfaceId, data.action, data.values))
        inputActions.submit()
        const ack: A2uiOpenerMessage = { type: 'a2ui/ack' }
        popup.postMessage(ack, location.origin)
      }
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [surfaceId, page, inputActions])

  const openWindow = (): void => {
    console.log('[a2ui] openWindow clicked', { surfaceId, path: A2UI_POPUP_PATH })
    let win = window.open(A2UI_POPUP_PATH, `a2ui-${surfaceId}`, 'popup=yes,width=920,height=760')
    if (win === null) {
      // Some blockers reject the named window but allow an unnamed one.
      win = window.open(A2UI_POPUP_PATH, '_blank', 'width=920,height=760')
    }
    console.log('[a2ui] window.open result', win === null ? 'null (blocked)' : 'window opened')
    if (win === null) {
      setBlocked(true)
      return
    }
    popupRef.current = win
    setBlocked(false)
  }

  return (
    <div className={css.launcher}>
      <h3 className={css.title}>{page.title}</h3>
      {page.description !== undefined && <p className={css.description}>{page.description}</p>}
      <button type="button" className={css.launcherButton} onClick={openWindow}>{t('launcher.open')}</button>
      {blocked && (
        <p className={css.launcherError} role="alert">
          {t('launcher.popupBlocked')}{' '}
          <a href={A2UI_POPUP_PATH} target="_blank" rel="noreferrer">{t('launcher.openDirectly')}</a>
        </p>
      )}
    </div>
  )
}
