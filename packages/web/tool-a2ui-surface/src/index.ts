/**
 * Model-facing A2UI surface tool: the model authors a declarative page JSON
 * the web UI renders natively, and the session log records the surface for
 * durable replay. A later user submission reaches the model as an ordinary
 * `user/message` carrying the `surfaceId` and the collected field values.
 * Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-tool-a2ui-surface
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { A2uiField, A2uiPage } from './types.ts'

export type * from './types.ts'

export const name = 'tool-a2ui-surface'
export const inject = ['tools']

/** The valid {@link A2uiField} widget kinds, as a runtime set for input narrowing. */
export const FIELD_TYPES = ['text', 'textarea', 'select', 'number', 'checkbox'] as const

/** Model-facing A2UI surface tool configuration. */
export interface Config {
  /**
   * Required deployment choice for whether the model may pass an explicit
   * `surfaceId` to REPLACE an existing surface. True suits flows where the
   * model refines a page after the user submits; false always mints a fresh
   * surface per call and makes every call open-only.
   */
  allowUpdate: boolean
}

/** Schemastery configuration for the A2UI surface tool consumer. */
export const Config: z<Config> = z.object({
  allowUpdate: z.boolean().required(),
})

const DESCRIPTION = 'Render an interactive form page in the web UI. The page JSON '
  + 'you provide is drawn natively by the browser as a fillable form; the user '
  + 'fills it in and clicks submit, and you then receive a message carrying the '
  + 'same `surfaceId` plus the collected field values keyed by field `name`. '
  + 'Use this to collect structured input from the user instead of asking '
  + 'open-ended questions. Keep fields to the ones you genuinely need, give '
  + 'every field a short unique `name` and a human `label`, and set '
  + '`required: true` only for mandatory input. For `select` fields provide '
  + '`options` (label/value pairs); for free text prefer `text`, for longer '
  + 'input `textarea`; use `number` for numeric values and `checkbox` for '
  + 'booleans. The optional `instruction` tells the user what will happen with '
  + 'the submitted values — put it where it helps them answer.'

/**
 * Mint a fresh, collision-resistant surface identity.
 * @returns a stable `surfaceId` for one open call.
 */
function mintSurfaceId(): string {
  return `a2ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Validate the value constraints the ParameterSchemaSpec can't express and
 * build the canonical {@link A2uiPage}: trimmed non-empty title, unique
 * trimmed field names, and every `select` field carrying at least one option.
 * The registry has already enforced the field enum and rejected unknown keys
 * (`additionalProperties: false` — the logged page must equal what the model
 * believes it wrote, so a nested or extended shape fails loud at the schema
 * boundary); the casts below record that guarantee.
 * @param raw - the model-supplied page, already schema-checked.
 * @returns the canonical page.
 */
function toA2uiPage(raw: {
  title: string
  description?: string
  submitLabel?: string
  instruction?: string
  fields: A2uiField[]
}): A2uiPage {
  const title = raw.title.trim()
  if (title.length === 0) throw new Error('invalid a2ui page: `title` must be a non-empty string')
  const seen = new Set<string>()
  const fields: A2uiField[] = []
  for (const field of raw.fields) {
    const name = field.name.trim()
    const label = field.label.trim()
    if (name.length === 0) throw new Error('invalid a2ui field: `name` must be a non-empty string')
    if (label.length === 0) throw new Error(`invalid a2ui field ${JSON.stringify(name)}: \`label\` must be a non-empty string`)
    if (seen.has(name)) throw new Error(`invalid a2ui page: duplicate field name ${JSON.stringify(name)}`)
    seen.add(name)
    if (field.type === 'select' && (field.options === undefined || field.options.length === 0)) {
      throw new Error(`invalid a2ui field ${JSON.stringify(name)}: a \`select\` field needs at least one option`)
    }
    const next: A2uiField = {
      name,
      label,
      type: field.type,
      ...field.required === undefined ? {} : { required: field.required },
      ...field.placeholder === undefined ? {} : { placeholder: field.placeholder },
      ...field.options === undefined ? {} : { options: field.options },
      ...field.help === undefined ? {} : { help: field.help },
    }
    fields.push(next)
  }
  return {
    title,
    ...raw.description === undefined ? {} : { description: raw.description },
    fields,
    ...raw.submitLabel === undefined ? {} : { submitLabel: raw.submitLabel },
    ...raw.instruction === undefined ? {} : { instruction: raw.instruction },
  }
}

/**
 * Register the `a2ui_surface` tool on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's explicit update policy.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'a2ui_surface',
    description: DESCRIPTION,
    parameters: {
      page: {
        type: 'object',
        required: true,
        description: 'The declarative page the browser renders as a form.',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true, description: 'Page heading shown above the fields.' },
          description: { type: 'string', description: 'Optional explanatory text under the title.' },
          submitLabel: { type: 'string', description: 'Submit button label; defaults to the UI locale copy.' },
          instruction: { type: 'string', description: 'What the user should expect after submitting.' },
          fields: {
            type: 'array',
            required: true,
            description: 'Form controls, one per input the user must provide.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true, description: 'Stable identity the submission payload keys by.' },
                label: { type: 'string', required: true, description: 'Human-readable control label.' },
                type: { type: 'string', required: true, enum: [...FIELD_TYPES], description: 'Widget kind.' },
                required: { type: 'boolean', description: 'Whether the user must fill the field.' },
                placeholder: { type: 'string', description: 'Placeholder while the control is empty.' },
                help: { type: 'string', description: 'Short help text under the control.' },
                options: {
                  type: 'array',
                  description: 'Selectable options; meaningful only for `select`.',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      label: { type: 'string', required: true, description: 'Option text.' },
                      value: { type: 'string', required: true, description: 'Stable option value.' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      surfaceId: {
        type: 'string',
        description: 'Optional stable identity to replace an existing surface (only when updates are allowed).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          surfaceId: { type: 'string', required: true },
          accepted: { type: 'boolean', required: true },
          fieldCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Rendered A2UI surface ${value.surfaceId} with ${value.fieldCount} fields.`,
      }],
    },
    execute(args, exec) {
      const page = toA2uiPage(args.page)
      if (!exec.agent) {
        // The surface is per-agent-session state; a non-agent caller (no
        // owning session) has nowhere to write it. Reject rather than no-op.
        throw new Error('a2ui_surface requires an owning agent session')
      }
      if (args.surfaceId !== undefined && !config.allowUpdate) {
        throw new Error('a2ui_surface cannot replace a surface: updates are disabled by this deployment')
      }
      const surfaceId = args.surfaceId ?? mintSurfaceId()
      exec.agent.session.append('a2ui/surface', { surfaceId, page })
      return Promise.resolve({ surfaceId, accepted: true, fieldCount: page.fields.length })
    },
    presentCall: args => ({ card: 'generic', title: 'Render A2UI page', kind: 'other', rawInput: args.page }),
  }))
}
