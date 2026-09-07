/**
 * Shared A2UI page chrome and renderer props: the model-authored title,
 * description, instruction, and submission controls that both the form and
 * the canvas renderer draw around their interactive body. Keeping the chrome
 * in one place keeps the two renderers' error, busy, and locale behavior
 * identical.
 */

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { A2uiAction, A2uiPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import css from './A2uiPanel.module.css'

/** Complete keyed Chat renderer props for one model-opened A2UI page. */
export type A2uiPanelProps =
  PropsRuntime<'conversation.chat.node', 'a2ui-surface'>
  & PropsLocale<'a2ui'>

/** Validation failure: a locale key with its parameter or a plain text message. */
export type FormError =
  | { key: 'error.required'; name: string }
  | { key: 'error.custom'; name: string }
  | { key: 'error.busy' }

/**
 * Draw the chrome shared by every A2UI page: heading, description, the page
 * body slot, the model-authored instruction, the validation error, the action
 * buttons, and the submit button wired to the owning form.
 * @param page - the model-authored page (chrome reads only the shared fields).
 * @param error - the current validation failure, if any.
 * @param busy - whether a submission is in flight and the button is disabled.
 * @param t - the `a2ui` locale translator.
 * @param onAction - invoked with the triggered action when an action button is
 *   clicked; the owning renderer validates and submits the trigger.
 * @param children - the page kind's interactive body.
 */
export function A2uiChrome({ page, error, busy, t, onAction, children }: {
  page: A2uiPage
  error: FormError | null
  busy: boolean
  t: A2uiPanelProps['t']
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
      <div className={css.actions}>
        {page.actions?.map(action => (
          <Button
            key={action.id}
            type="button"
            variant="outline"
            disabled={busy}
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

/**
 * Serialize one action trigger as an ordinary user message the model receives:
 * the stable `surfaceId`, the triggered action's id and target tool, its
 * instruction, and the collected values. The model invokes the named tool with
 * those values.
 * @param surfaceId - the durable surface identity.
 * @param action - the triggered action.
 * @param values - the collected values (the tool's arguments).
 * @returns the JSON message text.
 */
export function a2uiActionMessage(surfaceId: string, action: A2uiAction, values: Record<string, unknown>): string {
  return JSON.stringify({
    a2uiAction: { surfaceId, actionId: action.id, tool: action.tool, instruction: action.instruction, values },
  })
}

/**
 * Serialize one submission as an ordinary user message the model receives:
 * a stable `surfaceId` plus the kind-specific payload (`values` for a form,
 * `graph` for a canvas).
 * @param surfaceId - the durable surface identity.
 * @param payload - the collected values or the arranged graph.
 * @returns the JSON message text.
 */
export function a2uiSubmitMessage(surfaceId: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ a2uiSubmit: { surfaceId, ...payload } })
}
