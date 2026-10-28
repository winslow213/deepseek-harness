/** Shell launch menu owned by the terminal provider's guide entry. */
import { useEffect, useState, type ReactNode } from 'react'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { PluginArtworkTerminal, ShortcutKeys, Button, IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TerminalLaunchShells } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { TerminalAvailability } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './locales.ts'
import css from './TerminalGuide.module.css'

/** Provider-owned discovery and browser preference writes. */
export interface TerminalGuideInjected {
  readonly hooks: { readonly shortcuts: HostObservable<readonly ShortcutCatalogEntry[]> }
  /** @param signal - open menu lifetime. @returns current Host choices and browser preference. */
  readonly loadShells: (signal: AbortSignal) => Promise<TerminalLaunchShells>
  /** @param signal - query lifetime. @returns whether this Session's workspace may open a terminal. */
  readonly loadAvailability: (signal: AbortSignal) => Promise<TerminalAvailability>
  /** @param path - Host-discovered shell selected for the next terminal. */
  readonly selectShell: (path: string) => void
}

/** Session guide owner props, framework hooks and terminal actions. */
export type TerminalGuideProps = PropsRuntime<'sidebar.right.tab.guide.entry'> & PropsLocale<'sidebarTerminal'> & InjectFace<TerminalGuideInjected>

type MenuState = { phase: 'loading' } | { phase: 'ready'; choices: TerminalLaunchShells } | { phase: 'failed'; message: string }

/** Availability of the enclosing Session's workspace, read once per guide mount. */
type AvailabilityState =
  | { phase: 'checking' }
  | { phase: 'available' }
  | { phase: 'unavailable'; reason: Extract<TerminalAvailability, { available: false }>['reason'] }

/**
 * Open the remembered shell from the card or choose another shell from its menu.
 * The card displays its effective shortcut; the shell menu sits beside the title.
 * @param props - guide copy, enclosing tab actions and cancellable discovery.
 * @returns separate launch and menu buttons within one guide card.
 */
export function TerminalGuide({
  title, description, kind, useTabInfo, loadShells, loadAvailability, selectShell, t, useShortcuts,
}: TerminalGuideProps): ReactNode {
  const shortcut = useShortcuts(entries => entries.find(entry => entry.id === 'terminal.new'))
  const { tab } = useTabInfo()
  const [availability, setAvailability] = useState<AvailabilityState>({ phase: 'checking' })
  useEffect(() => {
    const lifetime = new AbortController()
    void loadAvailability(lifetime.signal).then((value) => {
      if (lifetime.signal.aborted) return
      setAvailability(value.available ? { phase: 'available' } : { phase: 'unavailable', reason: value.reason })
    }, () => {
      // An unreadable availability answer is not a confinement decision: fall
      // back to the launch affordance and let the Host refuse an allocation it
      // must refuse, rather than hiding the terminal behind a failed query.
      if (!lifetime.signal.aborted) setAvailability({ phase: 'available' })
    })
    return () => { lifetime.abort() }
  }, [loadAvailability])
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<MenuState>({ phase: 'loading' })
  useEffect(() => {
    if (!open) return
    const lifetime = new AbortController()
    void loadShells(lifetime.signal).then((choices) => {
      if (!lifetime.signal.aborted) setState({ phase: 'ready', choices })
    }, (error: unknown) => {
      if (!lifetime.signal.aborted) setState({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    })
    return () => { lifetime.abort() }
  }, [open, attempt, loadShells])
  const items = state.phase === 'ready'
    ? state.choices.shells.map(shell => ({ id: shell.path, label: shell.name }))
    : state.phase === 'loading'
      ? [{ id: 'loading', label: t('shellLoading'), disabled: true }]
      : [{ id: 'error', label: t('failed', { message: state.message }), disabled: true }, { id: 'retry', label: t('retry') }]
  if (availability.phase === 'unavailable') {
    return <div className={css.entry} data-sidebar-right-guide-entry={kind} data-terminal-unavailable={availability.reason}>
      <span className={css.icon} aria-hidden="true"><PluginArtworkTerminal size={description === undefined ? 22 : 26} /></span>
      <span className={css.text}>
        <span className={css.titleRow}><span className={css.title} aria-hidden="true">{title}</span></span>
        <span className={css.description}>{t('notMountedWorkspace')}</span>
      </span>
    </div>
  }
  return <div className={css.entry} data-sidebar-right-guide-entry={kind}>
    <Button variant="ghost" className={css.main} aria-label={description === undefined ? title : `${title} ${description}`} aria-keyshortcuts={shortcut?.aria}
      onClick={() => { tab.actions.openTab('terminal', { replaceTab: true }) }} />
    <span className={css.icon} aria-hidden="true"><PluginArtworkTerminal size={description === undefined ? 22 : 26} /></span>
    <span className={css.text}>
      <span className={css.titleRow}>
        <span className={css.title} aria-hidden="true">{title}</span>
        <Menu
          open={open} portal autoFocus align="end" className={css.menu}
          items={items.length === 0 ? [{ id: 'empty', label: t('shellEmpty'), disabled: true }] : items}
          selectedId={state.phase === 'ready' ? state.choices.selectedShell : undefined}
          onClose={() => { setOpen(false) }}
          onSelect={(path) => {
            if (state.phase === 'failed') { setState({ phase: 'loading' }); setAttempt(value => value + 1); return }
            selectShell(path)
            setOpen(false)
            tab.actions.openTab('terminal', { replaceTab: true, params: { shellPath: path } })
          }}
          anchor={<Button variant="ghost" className={css.trigger} aria-label={t('shell')} aria-haspopup="menu" aria-expanded={open}
            onClick={() => { setState({ phase: 'loading' }); setOpen(value => !value) }}>
            <IconChevronDownOutlineRegular />
          </Button>}
        />
      </span>
      {description !== undefined && <span className={css.description} aria-hidden="true">{description}</span>}
    </span>
    {shortcut !== undefined && shortcut.keys.length > 0 && <ShortcutKeys keys={shortcut.keys} className={css.shortcut} />}
  </div>
}
