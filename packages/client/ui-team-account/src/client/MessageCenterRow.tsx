/**
 * Message Center row registered into the General section item slot: title and
 * hint on the left, a chevron on the right, the whole cell the tap target.
 * Clicking opens the team account service's `/inbox` page in a new tab, so the
 * conversation the member is currently in stays intact. The row renders only
 * while the document carries the `<meta name="team-shell" content="1">` marker
 * the team reverse proxy injects, matching the other team rows.
 */
import { IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { hasTeamShellMarker } from './TeamAccountRow.tsx'
import css from './MessageCenterRow.module.css'

/** Full component props: runtime share + locale seat (the row owns no state). */
export type MessageCenterRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings.teamAccount'>

/**
 * Render the Message Center row.
 * @param props - composed slot props.
 * @returns the row, or null when the team-shell marker is absent.
 */
export function MessageCenterRow({ t }: MessageCenterRowProps) {
  if (!hasTeamShellMarker()) return null

  const open = (): void => {
    window.open('/inbox', '_blank', 'noopener')
  }

  return (
    <button
      type="button"
      className={css.row}
      onClick={open}
    >
      <span className={css.rowText}>
        <span className={css.title}>{t('messageCenterTitle')}</span>
        <span className={css.desc}>{t('messageCenterHint')}</span>
      </span>
      <IconChevronRightOutline14 className={css.chevron} />
    </button>
  )
}
