/**
 * Shared A2UI page chrome and renderer props: the model-authored title,
 * description, instruction, and submission controls that both the form and
 * the canvas renderer draw around their interactive body. Keeping the chrome
 * in one place keeps the two renderers' error, busy, result, and locale
 * behavior identical. The props are channel-agnostic: the standalone popup
 * supplies them directly, with no slot dependency.
 */

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { A2uiAction, A2uiPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import type { A2uiKey } from './locales.ts'
import css from './A2uiPanel.module.css'

/** Locale translator for the `a2ui` namespace, shared by both renderers. */
export type A2uiTranslate = (key: A2uiKey, params?: Record<string, string>) => string

/** Complete renderer props for one page, independent of the chat slot. */
export interface A2uiPageProps {
  /** The declarative page being rendered. */
  readonly page: A2uiPage
  /** The stable surface identity the submission correlates with. */
  readonly surfaceId: string
  /** The `a2ui` locale translator. */
  readonly t: A2uiTranslate
  /** Whether a model submission is in flight and controls are disabled. */
  readonly busy: boolean
  /** Submit the collected payload to the model (via the opener in a popup). */
  onSubmit(payload: Record<string, unknown>): void
  /** Trigger a `model`-mode action (via the opener in a popup). */
  onAction(action: A2uiAction, values: Record<string, unknown>): void
}

/** Whether a `local` action's step list terminates the correlated job. */
function hasStopStep(action: A2uiAction): boolean {
  return action.execution === 'local' && (action.steps?.some(step => step.kind === 'stop') ?? false)
}

/** Validation failure: a locale key with its parameter or a plain text message. */
export type FormError =
  | { key: 'error.required'; name: string }
  | { key: 'error.custom'; name: string }
  | { key: 'error.busy' }

/**
 * Draw the chrome shared by every A2UI page: heading, description, the page
 * body slot, the model-authored instruction, the validation error, the local
 * action result, the action buttons, and the submit button wired to the
 * owning form.
 * @param page - the model-authored page (chrome reads only the shared fields).
 * @param error - the current validation failure, if any.
 * @param busy - whether a submission is in flight and the button is disabled.
 * @param localResult - the current local-action result to display, if any.
 * @param t - the `a2ui` locale translator.
 * @param onAction - invoked with the triggered action when an action button is
 *   clicked; the owning renderer resolves it (local result or model submit).
 * @param children - the page kind's interactive body.
 */
export function A2uiChrome({ page, error, busy, localResult, t, onAction, children }: {
  page: A2uiPage
  error: FormError | null
  busy: boolean
  localResult: string | null
  t: A2uiTranslate
  onAction?: (action: A2uiAction) => void
  children: ReactNode
}) {
  return (
    <>
      <h3 className={css.title}>{page.title}</h3>
      {page.description !== undefined && <p className={css.description}>{page.description}</p>}
      {children}
      {page.instruction !== undefined && <p className={css.instruction}>{page.instruction}</p>}
      {error !== null && (
        <p className={css.error} role="alert">
          {error.key === 'error.required'
            ? t('error.required', { name: error.name })
            : error.key === 'error.custom'
              ? error.name
              : t('error.busy')}
        </p>
      )}
      {localResult !== null && <p className={css.result} role="status">{localResult}</p>}
      <div className={css.actions}>
        {page.actions?.map(action => (
          <Button
            key={action.id}
            type="button"
            variant="outline"
            // A `local` action carrying a `stop` step terminates the correlated
            // job, so it must stay clickable while a run is in flight; every
            // other action is disabled while busy.
            disabled={busy && !hasStopStep(action)}
            onClick={() => { onAction?.(action) }}
          >
            {action.label}
          </Button>
        ))}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t('button.submitting') : (page.submitLabel ?? t('button.submit'))}
        </Button>
      </div>
    </>
  )
}
