/**
 * Team Shell Sign out row registered into the General section item slot
 * (figma 501:30011 'Setting-Cell'): title + hint on the left, a chevron on
 * the right, the whole cell the tap target. Clicking posts to the same-origin
 * `/api/logout` — which the team reverse proxy answers by clearing both the
 * team session and the dsh instance cookie — and then navigates to `/`.
 * The row renders only while the document carries the `<meta name="team-shell"
 * content="1">` marker the team reverse proxy injects; without it the plugin
 * contributes nothing visible, which keeps plain single-user dsh clean.
 */
import { IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import css from './TeamAccountRow.module.css'

/** Meta tag name the team reverse proxy injects into served documents. */
export const TEAM_SHELL_MARKER = 'team-shell'

/**
 * Whether the current document was served by the team reverse proxy.
 * @returns true when the document head carries the team-shell marker.
 */
export function hasTeamShellMarker(): boolean {
  return document.head.querySelector(`meta[name="${TEAM_SHELL_MARKER}"][content="1"]`) !== null
}

/** Full component props: runtime share + locale seat (the row owns no state). */
export type TeamAccountRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings.teamAccount'>

/**
 * Render the Sign out row.
 * @param props - composed slot props.
 * @returns the row, or null when the team-shell marker is absent.
 */
export function TeamAccountRow({ t }: TeamAccountRowProps) {
  if (!hasTeamShellMarker()) return null

  const signOut = async (): Promise<void> => {
    await fetch('/api/logout', { method: 'POST' })
    window.location.href = '/'
  }

  return (
    <button
      type="button"
      className={css.row}
      onClick={() => { void signOut() }}
    >
      <span className={css.rowText}>
        <span className={css.title}>{t('title')}</span>
        <span className={css.desc}>{t('hint')}</span>
      </span>
      <IconChevronRightOutline14 className={css.chevron} />
    </button>
  )
}
