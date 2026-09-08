/** The saved-A2UI-tools sidebar panel: list, open, and remove saved tool pages. */

import { useRef, useState } from 'react'
import {
  IconChevronRightOutline14, IconTrashOutline16, IconCloseOutline16, Tooltip,
  useDismissOnOutsidePointer,
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
}

/** Full panel props composed by the sidebar footer-action slot. */
export type A2uiStorePanelProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<A2uiStorePanelFace> & PropsLocale<'a2uiStore'>

type PanelPhase = 'closed' | 'loading' | 'ready' | 'error'

/** Render the saved-tools panel entry and its popover list. */
export function A2uiStorePanel({ wide, useSessions, t, listTools, openTool, removeTool }: A2uiStorePanelProps) {
  const [phase, setPhase] = useState<PanelPhase>('closed')
  const [tools, setTools] = useState<readonly A2uiToolWire[]>([])
  const [openError, setOpenError] = useState(false)
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

  return (
    <div className={css.root} ref={rootRef}>
      <Tooltip label={t('entry.hint')} delayMs={500} disabled={wide}>
        <button
          type="button"
          className={css.entry}
          aria-label={t('entry.title')}
          onClick={() => {
            setOpenError(false)
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

          {phase === 'loading' && <p className={css.hint}>{t('panel.loadError')}</p>}
          {phase === 'error' && <p className={css.hint}>{t('panel.loadError')}</p>}
          {openError && <p className={css.hint}>{current === undefined ? t('panel.needSession') : t('panel.openError')}</p>}
          {phase === 'ready' && tools.length === 0 && <p className={css.hint}>{t('panel.empty')}</p>}

          <ul className={css.list}>
            {tools.map(tool => (
              <li className={css.row} key={tool.name}>
                <button type="button" className={css.open} onClick={() => { void open(tool.name) }}>
                  {tool.page.title}
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
