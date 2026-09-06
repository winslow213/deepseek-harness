/**
 * Team Shell Pairing code row registered into the General section item slot.
 * Clicking mints a multi-device pairing code through the same-origin
 * `/api/pairings` (proxied to the account service), then shows the code, the
 * claim command to run on each device, and a copy control. The row renders
 * only while the document carries the `<meta name="team-shell" content="1">`
 * marker, matching the Sign out row.
 */
import { useState } from 'react'
import { IconCheckOutline16, IconCopyOutline16, IconChevronRightOutline14, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { hasTeamShellMarker } from './TeamAccountRow.tsx'
import css from './PairingRow.module.css'

/** Minted-code view state (the row owns no shared state). */
interface PairingState {
  phase: 'idle' | 'busy' | 'ready' | 'error'
  code?: string
  expiresAt?: number
}

/** Full component props: runtime share + locale seat. */
export type PairingRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings.teamAccount'>

/** Format an epoch-ms expiry as a short local time. */
function formatExpiry(expiresAt: number): string {
  return new Date(expiresAt).toLocaleTimeString()
}

/**
 * Render the Pairing code row.
 * @param props - composed slot props.
 * @returns the row, or null when the team-shell marker is absent.
 */
export function PairingRow({ t }: PairingRowProps) {
  const [state, setState] = useState<PairingState>({ phase: 'idle' })
  const [copied, setCopied] = useState(false)

  if (!hasTeamShellMarker()) return null

  const command = state.code === undefined
    ? undefined
    : t('pairCommand', { code: state.code, host: window.location.hostname })

  const mint = async (): Promise<void> => {
    setState({ phase: 'busy' })
    try {
      const res = await fetch('/api/pairings', { method: 'POST' })
      if (!res.ok) {
        console.error(`[team-account] pairing mint failed: HTTP ${String(res.status)}`)
        setState({ phase: 'error' })
        return
      }
      const body = await res.json() as { uuid?: unknown; expiresAt?: unknown }
      if (typeof body.uuid !== 'string' || typeof body.expiresAt !== 'number') {
        setState({ phase: 'error' })
        return
      }
      setState({ phase: 'ready', code: body.uuid, expiresAt: body.expiresAt })
      setCopied(false)
    } catch {
      setState({ phase: 'error' })
    }
  }

  const copy = async (text: string): Promise<void> => {
    const ok = await writeClipboard(text)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1500)
    }
  }

  return (
    <div className={css.container}>
      <button type="button" className={css.row} onClick={() => { void mint() }} disabled={state.phase === 'busy'}>
        <span className={css.rowText}>
          <span className={css.title}>{t('pairTitle')}</span>
          <span className={css.desc}>{t('pairHint')}</span>
        </span>
        <IconChevronRightOutline14 className={css.chevron} />
      </button>

      {state.phase === 'ready' && state.code !== undefined && (
        <div className={css.panel}>
          <p className={css.meta}>
            {t('pairExpiry', { time: formatExpiry(state.expiresAt ?? 0) })}
            {' · '}
            {t('pairMulti')}
          </p>
          <div className={css.field}>
            <span className={css.label}>{t('pairCodeLabel')}</span>
            <div className={css.valueRow}>
              <code className={css.code}>{state.code}</code>
              <button type="button" className={css.copy} onClick={() => { void copy(state.code as string) }} aria-label={t('copy')}>
                {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
              </button>
            </div>
          </div>
          <div className={css.field}>
            <span className={css.label}>{t('pairCommandLabel')}</span>
            <div className={css.valueRow}>
              <code className={css.command}>{command}</code>
              <button type="button" className={css.copy} onClick={() => { void copy(command as string) }} aria-label={t('copy')}>
                {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
              </button>
            </div>
          </div>
        </div>
      )}

      {state.phase === 'error' && (
        <p className={css.error}>{t('pairError')}</p>
      )}
    </div>
  )
}
