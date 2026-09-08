/**
 * Standalone A2UI page renderer for the dedicated popup window. It mounts a
 * minimal React root that draws the form or canvas page with no slot
 * dependency: local actions resolve in-browser, while submissions and
 * model-mode actions post a typed message back to the opener window (the main
 * dsh app), which owns the session and forwards them to the model.
 * @module @deepseek-ai/dsh-client-ui-a2ui/standalone
 */

import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { A2uiAction, A2uiPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import { A2uiCanvasPanel } from './A2uiCanvasPanel.tsx'
import { A2uiFormPanel } from './A2uiFormPanel.tsx'
import type { A2uiTranslate } from './a2ui-chrome.tsx'
import type { A2uiPopupMessage, A2uiOpenerMessage } from './a2ui-wire.ts'
import { en, zh, type A2uiKey } from './locales.ts'

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

/** The popup host: owns the `busy` flag and posts submissions to the opener. */
function A2uiPopupHost({ surfaceId, page, t, opener }: {
  surfaceId: string
  page: A2uiPage
  t: A2uiTranslate
  opener: Window
}) {
  const [busy, setBusy] = useState(false)

  const onSubmit = useCallback((payload: Record<string, unknown>): void => {
    setBusy(true)
    const message: A2uiPopupMessage = { type: 'a2ui/submit', surfaceId, payload }
    opener.postMessage(message, location.origin)
  }, [surfaceId, opener])

  const onAction = useCallback((action: A2uiAction, values: Record<string, unknown>): void => {
    setBusy(true)
    const message: A2uiPopupMessage = { type: 'a2ui/action', surfaceId, action, values }
    opener.postMessage(message, location.origin)
  }, [surfaceId, opener])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== location.origin || event.source !== opener) return
      const data = event.data as A2uiOpenerMessage | null
      if (data?.type === 'a2ui/ack') setBusy(false)
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [opener])

  return page.kind === 'canvas'
    ? <A2uiCanvasPanel page={page} surfaceId={surfaceId} t={t} busy={busy} onSubmit={onSubmit} onAction={onAction} />
    : <A2uiFormPanel page={page} surfaceId={surfaceId} t={t} busy={busy} onSubmit={onSubmit} onAction={onAction} />
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
