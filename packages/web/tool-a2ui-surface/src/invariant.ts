/** Package-owned durable A2UI surface invariants. @module @deepseek-ai/dsh-tool-a2ui-surface/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-a2ui-surface'
const FIELD_TYPES = new Set(['text', 'textarea', 'select', 'number', 'checkbox'])
const PAGE_KINDS = new Set(['form', 'canvas'])
const NODE_ROLES = new Set(['start', 'end'])

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

/** Validate one canvas page's nodes and edges as the renderer trusts them. */
function validateCanvas(page: Record<string, unknown>, fail: InvariantFailure): void {
  const { nodes, edges } = page
  if (!Array.isArray(nodes) || nodes.length === 0) {
    fail('a2ui/surface `page.nodes` must be a non-empty array')
  }
  const nodeIds = new Set<string>()
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) fail('a2ui/surface canvas nodes must be objects')
    const { id, label, position, role } = node as Record<string, unknown>
    if (typeof id !== 'string' || id.length === 0 || id.trim() !== id) {
      fail('a2ui/surface canvas node `id` must be non-empty and already trimmed')
    }
    if (typeof label !== 'string' || label.length === 0 || label.trim() !== label) {
      fail('a2ui/surface canvas node `label` must be non-empty and already trimmed')
    }
    if (nodeIds.has(id)) fail(`a2ui/surface repeats canvas node id ${JSON.stringify(id)}`)
    nodeIds.add(id)
    if (typeof position !== 'object' || position === null) {
      fail('a2ui/surface canvas node `position` must be an object')
    }
    const { x, y } = position as Record<string, unknown>
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
      fail('a2ui/surface canvas node `position` must be finite numbers')
    }
    if (role !== undefined && !NODE_ROLES.has(role as string)) {
      fail(`a2ui/surface canvas node carries unknown role ${JSON.stringify(role)}`)
    }
  }
  if (!Array.isArray(edges)) fail('a2ui/surface `page.edges` must be an array')
  const edgeIds = new Set<string>()
  for (const edge of edges) {
    if (typeof edge !== 'object' || edge === null) fail('a2ui/surface canvas edges must be objects')
    const { id, source, target } = edge as Record<string, unknown>
    if (typeof id !== 'string' || id.length === 0 || id.trim() !== id) {
      fail('a2ui/surface canvas edge `id` must be non-empty and already trimmed')
    }
    if (edgeIds.has(id)) fail(`a2ui/surface repeats canvas edge id ${JSON.stringify(id)}`)
    edgeIds.add(id)
    if (typeof source !== 'string' || typeof target !== 'string') {
      fail('a2ui/surface canvas edges must carry string source and target')
    }
    if (source === target) fail(`a2ui/surface canvas edge ${JSON.stringify(id)} connects a node to itself`)
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      fail(`a2ui/surface canvas edge ${JSON.stringify(id)} references a missing node`)
    }
  }
}

/**
 * Validate one durable `a2ui/surface` record: a known page `kind`, a
 * non-empty trimmed title, and the kind's content — a non-empty field list
 * with unique trimmed names and selectable options for a form, or unique
 * node ids with finite positions and edges whose endpoints exist for a
 * canvas. The shape is what the browser renderer trusts, so a log that
 * cannot render fails loud instead of degrading the UI silently.
 */
function validateSurface(data: unknown, fail: InvariantFailure): void {
  if (typeof data !== 'object' || data === null) fail('a2ui/surface data must be an object')
  const { surfaceId, page } = data as Record<string, unknown>
  if (typeof surfaceId !== 'string' || surfaceId.length === 0) {
    fail('a2ui/surface `surfaceId` must be a non-empty string')
  }
  if (typeof page !== 'object' || page === null) fail('a2ui/surface `page` must be an object')
  const record = page as Record<string, unknown>
  const { kind, title } = record
  if (typeof kind !== 'string' || !PAGE_KINDS.has(kind)) {
    fail('a2ui/surface `page.kind` must be "form" or "canvas"')
  }
  if (typeof title !== 'string' || title.length === 0 || title.trim() !== title) {
    fail('a2ui/surface `page.title` must be non-empty and already trimmed')
  }
  if (kind === 'canvas') {
    if (record.fields !== undefined) {
      fail('a2ui/surface canvas page must not carry `fields`')
    }
    validateCanvas(record, fail)
    return
  }
  if (record.nodes !== undefined || record.edges !== undefined) {
    fail('a2ui/surface form page must not carry `nodes` or `edges`')
  }
  const { fields } = record
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
    for (const event of session.snapshotEvents()) validateEvent(event, fail)
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
