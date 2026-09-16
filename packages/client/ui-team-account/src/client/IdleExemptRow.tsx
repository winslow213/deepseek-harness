/**
 * Keep-instance-running row registered into the General section item slot.
 * Reads the signed-in member's current `idleExempt` flag from `/api/me` on
 * mount and toggles it through `POST /api/me/idle-exempt` (session-authenticated,
 * proxied to the account service) — a self-service switch on the same
 * `dsh_users.idle_exempt` column the operator's `account-cli set-idle-exempt`
 * writes, scoped to the signed-in member's own account only. The row renders
 * only while the document carries the `<meta name="team-shell" content="1">`
 * marker, matching the Sign out and Pairing code rows.
 */
import { useEffect, useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { hasTeamShellMarker } from './TeamAccountRow.tsx'
import css from './IdleExemptRow.module.css'

/** Row view state: `undefined` while the initial `/api/me` read is in flight. */
interface IdleExemptState {
  exempt: boolean | undefined
  busy: boolean
  error: boolean
}

/** Full component props: runtime share + locale seat. */
export type IdleExemptRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings.teamAccount'>

/**
 * Render the Keep instance running row.
 * @param props - composed slot props.
 * @returns the row, or null when the team-shell marker is absent.
 */
export function IdleExemptRow({ t }: IdleExemptRowProps) {
  const [state, setState] = useState<IdleExemptState>({ exempt: undefined, busy: false, error: false })
  const marker = hasTeamShellMarker()

  useEffect(() => {
    if (!marker) return
    void (async () => {
      try {
        const res = await fetch('/api/me')
        if (!res.ok) {
          setState(s => ({ ...s, error: true }))
          return
        }
        const body = await res.json() as { user?: { idleExempt?: unknown } }
        const exempt = body.user?.idleExempt === true
        setState(s => ({ ...s, exempt }))
      } catch {
        setState(s => ({ ...s, error: true }))
      }
    })()
  }, [marker])

  if (!marker) return null

  const toggle = async (next: boolean): Promise<void> => {
    setState(s => ({ ...s, busy: true, error: false }))
    try {
      const res = await fetch('/api/me/idle-exempt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exempt: next }),
      })
      if (!res.ok) {
        setState(s => ({ ...s, busy: false, error: true }))
        return
      }
      setState({ exempt: next, busy: false, error: false })
    } catch {
      setState(s => ({ ...s, busy: false, error: true }))
    }
  }

  return (
    <div className={css.row}>
      <span className={css.rowText}>
        <span className={css.title}>{t('idleExemptTitle')}</span>
        <span className={css.desc}>{state.error ? t('idleExemptError') : t('idleExemptHint')}</span>
      </span>
      <Switch
        checked={state.exempt === true}
        onChange={(next) => { void toggle(next) }}
        disabled={state.exempt === undefined || state.busy}
        label={t('idleExemptTitle')}
      />
    </div>
  )
}
