import { useState, type ChangeEvent, type FormEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { A2uiField } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import css from './A2uiPanel.module.css'

/** One collected field value: the exact type the field widget produces. */
type FieldValue = string | number | boolean

/** All collected field values keyed by stable field `name`. */
type FormValues = Record<string, FieldValue>

/** Validation failure: a locale key with its parameter or a plain text message. */
type FormError = { key: 'error.required'; name: string } | { key: 'error.busy' }

/** Complete keyed Chat renderer props for one model-opened A2UI page. */
export type A2uiPanelProps =
  PropsRuntime<'conversation.chat.node', 'a2ui-surface'>
  & PropsLocale<'a2ui'>

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
  if (field.type !== 'number') return value ?? ''
  if (typeof value !== 'string' || value.trim() === '') return ''
  const parsed = Number(value)
  return Number.isNaN(parsed) ? '' : parsed
}

function FieldLabel({ field, t }: { field: A2uiField; t: A2uiPanelProps['t'] }) {
  return (
    <label className={css.label} htmlFor={`a2ui-${field.name}`}>
      <span className={css.labelText}>{field.label}</span>
      {field.required === true && <span className={css.required}>{t('field.required')}</span>}
    </label>
  )
}

function FieldControl({ field, value, onChange }: {
  field: A2uiField
  value: FieldValue | undefined
  onChange: (value: FieldValue) => void
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
          {(field.options ?? []).map(option => (
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

/** Render one model-authored A2UI page as a native, fillable, submittable form. */
export function A2uiPanel({ node, useInput, inputActions, t }: A2uiPanelProps) {
  const data = node.data
  const { page, surfaceId } = data
  const [values, setValues] = useState<FormValues>(() => Object.fromEntries(
    page.fields.map(field => [field.name, initialValue(field)]),
  ))
  const [error, setError] = useState<FormError | null>(null)
  const phase = useInput(state => state.phase)
  const busy = phase === 'adjudicating' || phase === 'claimed' || phase === 'submitting'

  const setValue = (name: string, value: FieldValue): void => {
    setValues(current => ({ ...current, [name]: value }))
    setError(null)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const missing = page.fields.find(field => field.required === true && isEmpty(field, values[field.name]))
    if (missing !== undefined) {
      setError({ key: 'error.required', name: missing.label })
      return
    }
    if (busy) {
      setError({ key: 'error.busy' })
      return
    }
    const payload = Object.fromEntries(page.fields.map(field => [
      field.name,
      payloadValue(field, values[field.name]),
    ]))
    const message = JSON.stringify({ a2uiSubmit: { surfaceId, values: payload } })
    inputActions.setDraft(message)
    inputActions.submit()
  }

  return (
    <form className={css.root} data-a2ui-surface={surfaceId} onSubmit={submit}>
      <h3 className={css.title}>{page.title}</h3>
      {page.description !== undefined && <p className={css.description}>{page.description}</p>}
      <div className={css.fields}>
        {page.fields.map(field => (
          <div className={css.field} key={field.name}>
            <FieldLabel field={field} t={t} />
            <FieldControl
              field={field}
              value={values[field.name]}
              onChange={(value) => { setValue(field.name, value) }}
            />
            {field.type !== 'checkbox' && field.help !== undefined
              && <span className={css.help}>{field.help}</span>}
          </div>
        ))}
      </div>
      {page.instruction !== undefined && <p className={css.instruction}>{page.instruction}</p>}
      {error !== null && (
        <p className={css.error} role="alert">
          {error.key === 'error.required' ? t('error.required', { name: error.name }) : t('error.busy')}
        </p>
      )}
      <div className={css.actions}>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t('button.submitting') : (page.submitLabel ?? t('button.submit'))}
        </Button>
      </div>
    </form>
  )
}
