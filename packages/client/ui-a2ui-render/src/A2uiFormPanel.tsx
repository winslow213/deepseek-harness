import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import type { A2uiAction, A2uiField, A2uiFieldOption, A2uiFormPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import {
  A2uiChrome, type A2uiPageProps, type A2uiTranslate, type FormError,
} from './a2ui-chrome.tsx'
import { evaluateA2uiExpression, type A2uiValues } from './a2ui-expression.ts'
import css from './A2uiPanel.module.css'

/** Renderer props for a form page, narrowed by the dispatcher. */
export interface A2uiFormPanelProps extends Omit<A2uiPageProps, 'page'> {
  /** The narrowed form page this renderer draws. */
  readonly page: A2uiFormPage
  /**
   * An optional external value write: when the host resolves a `command`/
   * `script` action and wants to write its outcome into a form field, or a
   * `local` action's step list mutates several fields at once, it supplies a
   * fresh patch (a new object identity each write) mapping field name to
   * value. The panel applies every entry to its named field once and clears
   * it.
   */
  readonly patch?: Readonly<Record<string, FieldValue>> | null
  /**
   * Runtime option sets keyed by `select` field name, overriding static
   * `field.options` for fields whose options come from an `optionsFrom`
   * script action or a host-backed `source`.
   */
  readonly optionSets?: Readonly<Record<string, readonly A2uiFieldOption[]>>
}

/** One collected field value: the exact type the field widget produces. */
export type FieldValue = string | number | boolean

/** All collected field values keyed by stable field `name`. */
type FormValues = Record<string, FieldValue>

/** The starting value of one field before the user touches it. */
function initialValue(field: A2uiField): FieldValue {
  if (field.type === 'checkbox') return false
  if (field.type === 'select') {
    const first = field.options?.[0]?.value
    if (first !== undefined) return first
  }
  return ''
}

/** Whether a collected value counts as empty for a `required` field. */
function isEmpty(field: A2uiField, value: FieldValue | undefined): boolean {
  if (field.type === 'checkbox') return value !== true
  return typeof value !== 'string' || value.trim() === ''
}

/** Project one collected value into the submission payload for its field kind. */
function payloadValue(field: A2uiField, value: FieldValue | undefined): FieldValue {
  if (field.type !== 'number') {
    /* v8 ignore next -- every field is seeded, so the indexed access yields a value */
    return value ?? ''
  }
  if (typeof value !== 'string' || value.trim() === '') return ''
  const parsed = Number(value)
  /* v8 ignore next -- a number input only yields numeric strings or '' */
  return Number.isNaN(parsed) ? '' : parsed
}

/**
 * Evaluate one model-authored expression, degrading to a safe fallback on any
 * grammar/reference/type error. Visibility and validation degrade permissive
 * (show / accept) so a bad expression never hides or blocks a field the user
 * must reach; a computed field degrades to an empty display.
 */
function tryEval(
  expression: string,
  values: A2uiValues,
  fallback: string | number | boolean | null,
): string | number | boolean | null {
  try {
    return evaluateA2uiExpression(expression, values)
  } catch {
    return fallback
  }
}

function FieldLabel({ field, t }: { field: A2uiField; t: A2uiTranslate }) {
  return (
    <label className={css.label} htmlFor={`a2ui-${field.name}`}>
      <span className={css.labelText}>{field.label}</span>
      {field.required === true && <span className={css.required}>{t('field.required')}</span>}
    </label>
  )
}

function FieldControl({ field, value, onChange, options }: {
  field: A2uiField
  value: FieldValue | undefined
  onChange: (value: FieldValue) => void
  /** Runtime-resolved options overriding static `field.options` (optionsFrom). */
  options?: readonly A2uiFieldOption[]
}) {
  const id = `a2ui-${field.name}`
  const stringValue = typeof value === 'string' ? value : ''
  const updateText = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>): void => {
    onChange(event.target.value)
  }
  switch (field.type) {
    case 'textarea':
      return (
        <textarea
          id={id}
          className={css.input}
          name={field.name}
          placeholder={field.placeholder}
          value={stringValue}
          onChange={updateText}
          rows={4}
        />
      )
    case 'select':
      return (
        <select
          id={id}
          className={css.input}
          name={field.name}
          value={stringValue}
          onChange={updateText}
        >
          {(options ?? field.options ?? []).map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      )
    case 'number':
      return (
        <input
          id={id}
          className={css.input}
          type="number"
          name={field.name}
          placeholder={field.placeholder}
          value={stringValue}
          onChange={updateText}
        />
      )
    case 'checkbox':
      return (
        <label className={css.checkboxRow}>
          <input
            id={id}
            type="checkbox"
            name={field.name}
            checked={value === true}
            onChange={(event: ChangeEvent<HTMLInputElement>) => { onChange(event.target.checked) }}
          />
          {field.help !== undefined && <span className={css.help}>{field.help}</span>}
        </label>
      )
    default:
      return (
        <input
          id={id}
          className={css.input}
          type="text"
          name={field.name}
          placeholder={field.placeholder}
          value={stringValue}
          onChange={updateText}
        />
      )
  }
}

/** Render one model-authored `form` page as a native, fillable, submittable form. */
export function A2uiFormPanel({ page, surfaceId, t, busy, onSubmit, onAction, patch, optionSets }: A2uiFormPanelProps) {
  const [values, setValues] = useState<FormValues>(() => Object.fromEntries(
    page.fields.filter(field => field.compute === undefined).map(field => [field.name, initialValue(field)]),
  ))
  // The last external patch the host applied (by object identity), so the same
  // patch value never re-applies on a re-render that did not change it.
  const appliedPatchRef = useRef<Readonly<Record<string, FieldValue>> | null>(null)
  useEffect(() => {
    if (patch === null || patch === undefined) return
    if (appliedPatchRef.current === patch) return
    appliedPatchRef.current = patch
    setValues((current) => {
      let next = current
      for (const [name, value] of Object.entries(patch)) {
        const target = page.fields.find(field => field.name === name)
        if (target !== undefined && target.compute === undefined) {
          next = { ...next, [name]: value }
        }
      }
      return next
    })
  }, [patch, page.fields])
  const [error, setError] = useState<FormError | null>(null)
  const [localResult, setLocalResult] = useState<string | null>(null)

  // Expression values: user inputs with `number` fields normalized to numbers
  // (the widget stores the raw text), plus derived compute fields evaluated in
  // declaration order so a computed field may reference earlier siblings.
  const exprValues = useMemo<A2uiValues>(() => {
    const result: Record<string, string | number | boolean | null> = { ...values }
    for (const field of page.fields) {
      if (field.type !== 'number' || field.compute !== undefined) continue
      const raw = result[field.name]
      if (typeof raw === 'string' && raw.trim() !== '') {
        const parsed = Number(raw)
        if (!Number.isNaN(parsed)) result[field.name] = parsed
      }
    }
    for (const field of page.fields) {
      if (field.compute === undefined) continue
      // A null result (the `null` literal, or a sibling that is null) degrades
      // to an empty display, since a form value is never null on the wire.
      result[field.name] = tryEval(field.compute, result, '') ?? ''
    }
    return result
  }, [values, page.fields])

  // Per-field visibility, evaluated against the expression values.
  const visibility = useMemo<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {}
    for (const field of page.fields) {
      map[field.name] = field.visibleWhen === undefined
        ? true
        : Boolean(tryEval(field.visibleWhen, exprValues, true))
    }
    return map
  }, [exprValues, page.fields])

  const setValue = (name: string, value: FieldValue): void => {
    setValues(current => ({ ...current, [name]: value }))
    setError(null)
    setLocalResult(null)
  }

  // Validate the visible fields and collect the submission payload. Returns
  // the first failure, or the collected values when the form is valid.
  const collect = (): { ok: true; values: Record<string, FieldValue> } | { ok: false; error: FormError } => {
    const visible = page.fields.filter(field => visibility[field.name] === true)
    const missing = visible.find(field =>
      field.compute === undefined && field.required === true && isEmpty(field, values[field.name]))
    if (missing !== undefined) {
      return { ok: false, error: { key: 'error.required', name: missing.label } }
    }
    for (const field of visible) {
      if (field.validateWhen === undefined) continue
      if (!Boolean(tryEval(field.validateWhen, exprValues, true))) {
        return { ok: false, error: { key: 'error.custom', name: field.validateMessage ?? field.label } }
      }
    }
    const collected = Object.fromEntries(visible.map(field => [
      field.name,
      field.compute !== undefined ? (exprValues[field.name] ?? '') : payloadValue(field, values[field.name]),
    ]))
    return { ok: true, values: collected }
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const outcome = collect()
    if (!outcome.ok) {
      setError(outcome.error)
      return
    }
    if (busy) {
      setError({ key: 'error.busy' })
      return
    }
    onSubmit({ values: outcome.values })
  }

  const triggerAction = (action: A2uiAction): void => {
    const outcome = collect()
    if (!outcome.ok) {
      setError(outcome.error)
      return
    }
    if (action.execution === 'local') {
      if (action.steps !== undefined && action.steps.length > 0) {
        // A step list needs the opener (refresh/stop) and field writes, so
        // delegate to the standalone host, which owns the popup channel and
        // patches the resulting field values back through `patch`.
        setError(null)
        onAction(action, outcome.values)
        return
      }
      setError(null)
      setLocalResult(action.result === undefined || action.result.trim().length === 0
        ? t('action.localDone')
        : String(tryEval(action.result, exprValues, action.result) ?? ''))
      return
    }
    if (busy) {
      setError({ key: 'error.busy' })
      return
    }
    onAction(action, outcome.values)
  }

  return (
    <form className={css.root} data-a2ui-surface={surfaceId} onSubmit={submit}>
      <A2uiChrome page={page} error={error} busy={busy} localResult={localResult} t={t} onAction={triggerAction}>
        <div className={css.fields}>
          {page.fields.filter(field => visibility[field.name]).map(field => (
            <div className={css.field} key={field.name}>
              <FieldLabel field={field} t={t} />
              {field.compute !== undefined
                ? <div className={css.computed}>{String(exprValues[field.name] ?? '')}</div>
                : <FieldControl
                  field={field}
                  value={values[field.name]}
                  {...((field.optionsFrom !== undefined || field.source !== undefined) && optionSets?.[field.name] !== undefined
                    ? { options: optionSets[field.name] }
                    : {})}
                  onChange={(value) => { setValue(field.name, value) }}
                />}
              {field.type !== 'checkbox' && field.help !== undefined
                && <span className={css.help}>{field.help}</span>}
            </div>
          ))}
        </div>
      </A2uiChrome>
    </form>
  )
}
