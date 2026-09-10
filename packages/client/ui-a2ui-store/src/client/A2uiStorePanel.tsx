/** The saved-A2UI-tools sidebar panel: list, open, remove, share, and import saved tool pages. */

import { useRef, useState } from 'react'
import {
  IconChevronRightOutline14, IconTrashOutline16, IconCloseOutline16, IconDownloadOutline16, IconShareOutline16,
  Tooltip, useDismissOnOutsidePointer, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { A2uiToolWire, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the Session root standard-hook merge (useSessions).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './A2uiStorePanel.module.css'

/** Injected face: the store verbs the panel drives. */
export interface A2uiStorePanelFace {
  listTools: () => Promise<{ tools: readonly A2uiToolWire[] }>
  openTool: (sessionId: SessionId, name: string) => Promise<{ surfaceId: string }>
  removeTool: (name: string) => Promise<{ removed: boolean }>
  shareTool: (name: string) => Promise<{ token: string }>
  importTool: (token: string) => Promise<{ name: string }>
}

/** Full panel props composed by the sidebar footer-action slot. */
export type A2uiStorePanelProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<A2uiStorePanelFace> & PropsLocale<'a2uiStore'>

type PanelPhase = 'closed' | 'loading' | 'ready' | 'error'

/** Render the saved-tools panel entry and its popover list. */
export function A2uiStorePanel({ wide, useSessions, t, listTools, openTool, removeTool, shareTool, importTool }: A2uiStorePanelProps) {
  const [phase, setPhase] = useState<PanelPhase>('closed')
  const [tools, setTools] = useState<readonly A2uiToolWire[]>([])
  const [openError, setOpenError] = useState(false)
  const [shareError, setShareError] = useState(false)
  const [sharedName, setSharedName] = useState<string | null>(null)
  const [importValue, setImportValue] = useState('')
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState(false)
  const current = useSessions(state => state.current)
  const rootRef = useRef<HTMLDivElement | null>(null)
  useDismissOnOutsidePointer(rootRef, phase !== 'closed', () => { setPhase('closed') })

  const load = async (): Promise<void> => {
    setPhase('loading')
    try {
      const result = await listTools()
      setTools(result.tools)
      setPhase('ready')
    } catch {
      setPhase('error')
    }
  }

  const open = async (name: string): Promise<void> => {
    if (current === undefined) {
      setOpenError(true)
      return
    }
    try {
      const { surfaceId } = await openTool(current, name)
      // Open the popup inside the click gesture so the browser never blocks
      // it; the chat launcher that the open event projects adopts this named
      // window and drives the ready/init handshake.
      window.open('/a2ui.html', `a2ui-${surfaceId}`, 'popup=yes,width=920,height=760')
      setPhase('closed')
    } catch {
      setOpenError(true)
    }
  }

  const remove = async (name: string): Promise<void> => {
    try {
      await removeTool(name)
      setTools(existing => existing.filter(tool => tool.name !== name))
    } catch {
      // A failed remove leaves the list unchanged; the next reload reconciles.
    }
  }

  const share = async (name: string): Promise<void> => {
    setShareError(false)
    setSharedName(null)
    try {
      const { token } = await shareTool(name)
      // writeClipboard falls back to execCommand('copy') on insecure contexts
      // (http hosts) where the async Clipboard API is absent, so the token
      // copies even outside a secure context.
      const copied = await writeClipboard(token)
      if (copied) setSharedName(name)
      else setShareError(true)
    } catch {
      setShareError(true)
    }
  }

  const importShared = async (): Promise<void> => {
    const token = importValue.trim()
    if (token.length === 0 || importing) return
    setImporting(true)
    setImportError(false)
    try {
      await importTool(token)
      setImportValue('')
      setImporting(false)
      const result = await listTools()
      setTools(result.tools)
      setPhase('ready')
    } catch {
      setImporting(false)
      setImportError(true)
    }
  }

  return (
    <div className={css.root} ref={rootRef}>
      <Tooltip label={t('entry.hint')} delayMs={500} disabled={wide}>
        <button
          type="button"
          className={css.entry}
          aria-label={t('entry.title')}
          onClick={() => {
            setOpenError(false)
            setImportError(false)
            setShareError(false)
            if (phase === 'closed') void load()
            else setPhase('closed')
          }}
        >
          <IconChevronRightOutline14 size={wide ? 14 : 18} />
          {wide && <span className={css.entryLabel}>{t('entry.title')}</span>}
        </button>
      </Tooltip>

      {phase !== 'closed' && (
        <div className={css.panel}>
          <div className={css.header}>
            <h3 className={css.title}>{t('panel.title')}</h3>
            <button type="button" className={css.close} aria-label={t('panel.close')} onClick={() => { setPhase('closed') }}>
              <IconCloseOutline16 />
            </button>
          </div>

          <div className={css.importRow}>
            <input
              className={css.importInput}
              placeholder={t('panel.importPlaceholder')}
              value={importValue}
              onChange={(event) => { setImportValue(event.target.value) }}
              disabled={importing}
            />
            <button type="button" className={css.importAction} aria-label={t('panel.import')} disabled={importing} onClick={() => { void importShared() }}>
              <IconDownloadOutline16 />
            </button>
          </div>

          {phase === 'loading' && <p className={css.hint}>{t('panel.loading')}</p>}
          {phase === 'error' && <p className={css.hint}>{t('panel.loadError')}</p>}
          {openError && <p className={css.hint}>{current === undefined ? t('panel.needSession') : t('panel.openError')}</p>}
          {importError && <p className={css.hint}>{t('panel.importError')}</p>}
          {shareError && <p className={css.hint}>{t('panel.shareError')}</p>}
          {sharedName !== null && <p className={css.hint}>{t('panel.shared', { name: sharedName })}</p>}
          {phase === 'ready' && tools.length === 0 && <p className={css.hint}>{t('panel.empty')}</p>}

          <ul className={css.list}>
            {tools.map(tool => (
              <li className={css.row} key={tool.name}>
                <button type="button" className={css.open} onClick={() => { void open(tool.name) }}>
                  {tool.page.title}
                </button>
                <button type="button" className={css.share} aria-label={t('row.share')} onClick={() => { void share(tool.name) }}>
                  <IconShareOutline16 />
                </button>
                <button type="button" className={css.remove} aria-label={t('row.remove')} onClick={() => { void remove(tool.name) }}>
                  <IconTrashOutline16 />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
