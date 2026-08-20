/** Package-owned durable A2UI surface invariants. @module @deepseek-ai/dsh-tool-a2ui-surface/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-a2ui-surface'
const FIELD_TYPES = new Set(['text', 'textarea', 'select', 'number', 'checkbox'])

/** Cordis companion plugin name. */
export const name = 'tool-a2ui-surface-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

function validateField(field: unknown, fail: InvariantFailure): void {
  if (typeof field !== 'object' || field === null) fail('a2ui/surface fields must be objects')
  const { name, label, type, options } = field as Record<string, unknown>
  if (typeof name !== 'string' || name.length === 0 || name.trim() !== name) {
    fail('a2ui/surface field `name` must be non-empty and already trimmed')
  }
  if (typeof label !== 'string' || label.length === 0 || label.trim() !== label) {
    fail('a2ui/surface field `label` must be non-empty and already trimmed')
  }
  if (typeof type !== 'string' || !FIELD_TYPES.has(type)) {
    fail(`a2ui/surface field carries unknown type ${JSON.stringify(type)}`)
  }
  if (type === 'select') {
    if (!Array.isArray(options) || options.length === 0) {
      fail('a2ui/surface `select` field must carry at least one option')
    }
    for (const option of options) {
      if (typeof option !== 'object' || option === null) fail('a2ui/surface select options must be objects')
      const { label: optionLabel, value } = option as Record<string, unknown>
      if (typeof optionLabel !== 'string' || typeof value !== 'string') {
        fail('a2ui/surface select options must carry string label and value')
      }
    }
  }
}

/**
 * Validate one durable `a2ui/surface` record: a non-empty trimmed title, a
 * non-empty field list with unique trimmed names, and selectable options for
 * every `select` field. The shape is what the browser renderer trusts, so a
 * log that cannot render fails loud instead of degrading the UI silently.
 */
function validateSurface(data: unknown, fail: InvariantFailure): void {
  if (typeof data !== 'object' || data === null) fail('a2ui/surface data must be an object')
  const { surfaceId, page } = data as Record<string, unknown>
  if (typeof surfaceId !== 'string' || surfaceId.length === 0) {
    fail('a2ui/surface `surfaceId` must be a non-empty string')
  }
  if (typeof page !== 'object' || page === null) fail('a2ui/surface `page` must be an object')
  const { title, fields } = page as Record<string, unknown>
  if (typeof title !== 'string' || title.length === 0 || title.trim() !== title) {
    fail('a2ui/surface `page.title` must be non-empty and already trimmed')
  }
  if (!Array.isArray(fields)) fail('a2ui/surface `page.fields` must be an array')
  const seen = new Set<string>()
  for (const field of fields) {
    validateField(field, fail)
    const fieldName = (field as { name?: string }).name
    if (typeof fieldName === 'string' && seen.has(fieldName)) {
      fail(`a2ui/surface repeats field name ${JSON.stringify(fieldName)}`)
    }
    if (typeof fieldName === 'string') seen.add(fieldName)
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'a2ui/surface') validateSurface(event.data, fail)
}

/** Install validation for loaded and newly appended A2UI surface records. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the A2UI surface invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
