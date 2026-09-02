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
import type {
  A2uiCanvasEdge, A2uiCanvasNode, A2uiCanvasPage, A2uiField, A2uiPage, A2uiPageKind,
} from './types.ts'

export type * from './types.ts'

export const name = 'tool-a2ui-surface'
export const inject = ['tools']

/** The valid {@link A2uiField} widget kinds, as a runtime set for input narrowing. */
export const FIELD_TYPES = ['text', 'textarea', 'select', 'number', 'checkbox'] as const

/** The model-supplied page shape, already schema-checked, before canonicalization. */
interface A2uiPageInput {
  kind: A2uiPageKind
  title: string
  description?: string
  submitLabel?: string
  instruction?: string
  fields?: A2uiField[]
  nodes?: A2uiCanvasNode[]
  edges?: A2uiCanvasEdge[]
}

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

const DESCRIPTION = 'Render an interactive page in the web UI. The page JSON you '
  + 'provide is drawn natively by the browser, the user interacts with it and '
  + 'submits, and you then receive a message carrying the same `surfaceId` plus '
  + 'the collected payload. Choose the page `kind` that fits the task: '
  + '`"form"` renders a fillable form that collects structured input — keep '
  + 'fields to the ones you genuinely need, give every field a short unique '
  + '`name` and a human `label`, set `required: true` only for mandatory input; '
  + 'for `select` fields provide `options` (label/value pairs); prefer `text` '
  + 'for free text, `textarea` for longer input, `number` for numeric values, '
  + '`checkbox` for booleans. `"canvas"` renders a draggable node graph the '
  + 'user arranges and connects — seed it with `nodes` (stable `id`, `label`, '
  + 'optional `detail`, and an initial `position`) and `edges` (each a stable '
  + '`id`, a `source` node id, and a `target` node id); the user may move '
  + 'nodes and add or remove connections before submitting. The optional '
  + '`instruction` tells the user what will happen with the submitted values.'

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
 * trimmed field names, every `select` field carrying at least one option,
 * and for `canvas` pages unique node ids with finite positions plus edges
 * whose endpoints reference existing nodes. The registry has already
 * enforced the enums and rejected unknown keys (`additionalProperties:
 * false` — the logged page must equal what the model believes it wrote, so a
 * nested or extended shape fails loud at the schema boundary); the casts
 * below record that guarantee.
 * @param raw - the model-supplied page, already schema-checked.
 * @returns the canonical page.
 */
function toA2uiPage(raw: A2uiPageInput): A2uiPage {
  const title = raw.title.trim()
  if (title.length === 0) throw new Error('invalid a2ui page: `title` must be a non-empty string')
  if (raw.kind === 'form') {
    if (raw.nodes !== undefined || raw.edges !== undefined) {
      throw new Error('invalid a2ui form page: a `form` page must not carry `nodes` or `edges`')
    }
    return {
      kind: 'form',
      title,
      ...raw.description === undefined ? {} : { description: raw.description },
      fields: toA2uiFields(raw.fields ?? []),
      ...raw.submitLabel === undefined ? {} : { submitLabel: raw.submitLabel },
      ...raw.instruction === undefined ? {} : { instruction: raw.instruction },
    }
  }
  if (raw.fields !== undefined) {
    throw new Error('invalid a2ui canvas page: a `canvas` page must not carry `fields`')
  }
  return {
    kind: 'canvas',
    title,
    ...raw.description === undefined ? {} : { description: raw.description },
    ...toA2uiCanvas(raw.nodes, raw.edges),
    ...raw.submitLabel === undefined ? {} : { submitLabel: raw.submitLabel },
    ...raw.instruction === undefined ? {} : { instruction: raw.instruction },
  }
}

/** Canonicalize the model-supplied field list, preserving the existing constraints. */
function toA2uiFields(rawFields: readonly A2uiField[]): A2uiField[] {
  const seen = new Set<string>()
  const fields: A2uiField[] = []
  for (const field of rawFields) {
    const name = field.name.trim()
    const label = field.label.trim()
    if (name.length === 0) throw new Error('invalid a2ui field: `name` must be a non-empty string')
    if (label.length === 0) throw new Error(`invalid a2ui field ${JSON.stringify(name)}: \`label\` must be a non-empty string`)
    if (seen.has(name)) throw new Error(`invalid a2ui page: duplicate field name ${JSON.stringify(name)}`)
    seen.add(name)
    if (field.type === 'select' && (field.options === undefined || field.options.length === 0)) {
      throw new Error(`invalid a2ui field ${JSON.stringify(name)}: a \`select\` field needs at least one option`)
    }
    fields.push({
      name,
      label,
      type: field.type,
      ...field.required === undefined ? {} : { required: field.required },
      ...field.placeholder === undefined ? {} : { placeholder: field.placeholder },
      ...field.options === undefined ? {} : { options: field.options },
      ...field.help === undefined ? {} : { help: field.help },
    })
  }
  return fields
}

/** Canonicalize the model-supplied canvas nodes and edges into the logged graph. */
function toA2uiCanvas(
  rawNodes: readonly A2uiCanvasNode[] | undefined,
  rawEdges: readonly A2uiCanvasEdge[] | undefined,
): Pick<A2uiCanvasPage, 'nodes' | 'edges'> {
  const nodes: A2uiCanvasNode[] = []
  const nodeIds = new Set<string>()
  for (const node of rawNodes ?? []) {
    const id = node.id.trim()
    const label = node.label.trim()
    if (id.length === 0) throw new Error('invalid a2ui canvas node: `id` must be a non-empty string')
    if (label.length === 0) throw new Error(`invalid a2ui canvas node ${JSON.stringify(id)}: \`label\` must be a non-empty string`)
    if (nodeIds.has(id)) throw new Error(`invalid a2ui canvas page: duplicate node id ${JSON.stringify(id)}`)
    nodeIds.add(id)
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) {
      throw new Error(`invalid a2ui canvas node ${JSON.stringify(id)}: \`position\` must be finite numbers`)
    }
    nodes.push({
      id,
      label,
      ...node.detail === undefined ? {} : { detail: node.detail },
      position: { x: node.position.x, y: node.position.y },
      ...node.role === undefined ? {} : { role: node.role },
    })
  }
  if (nodes.length === 0) throw new Error('invalid a2ui canvas page: a `canvas` page needs at least one node')
  const edges: A2uiCanvasEdge[] = []
  const edgeIds = new Set<string>()
  for (const edge of rawEdges ?? []) {
    const id = edge.id.trim()
    const source = edge.source.trim()
    const target = edge.target.trim()
    if (id.length === 0) throw new Error('invalid a2ui canvas edge: `id` must be a non-empty string')
    if (source.length === 0 || target.length === 0) {
      throw new Error(`invalid a2ui canvas edge ${JSON.stringify(id)}: \`source\` and \`target\` must be non-empty strings`)
    }
    if (edgeIds.has(id)) throw new Error(`invalid a2ui canvas page: duplicate edge id ${JSON.stringify(id)}`)
    edgeIds.add(id)
    if (source === target) throw new Error(`invalid a2ui canvas edge ${JSON.stringify(id)}: a node cannot connect to itself`)
    if (!nodeIds.has(source)) {
      throw new Error(`invalid a2ui canvas edge ${JSON.stringify(id)}: \`source\` node ${JSON.stringify(source)} does not exist`)
    }
    if (!nodeIds.has(target)) {
      throw new Error(`invalid a2ui canvas edge ${JSON.stringify(id)}: \`target\` node ${JSON.stringify(target)} does not exist`)
    }
    edges.push({ id, source, target, ...edge.label === undefined ? {} : { label: edge.label } })
  }
  return { nodes, edges }
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
        description: 'The declarative page the browser renders: `kind: "form"` draws a fillable form, `kind: "canvas"` a draggable node graph.',
        additionalProperties: false,
        properties: {
          kind: {
            type: 'string',
            required: true,
            enum: ['form', 'canvas'],
            description: 'Which renderer draws the page.',
          },
          title: { type: 'string', required: true, description: 'Page heading shown above the content.' },
          description: { type: 'string', description: 'Optional explanatory text under the title.' },
          submitLabel: { type: 'string', description: 'Submit button label; defaults to the UI locale copy.' },
          instruction: { type: 'string', description: 'What the user should expect after submitting.' },
          fields: {
            type: 'array',
            description: 'Form controls, one per input the user must provide; required when `kind` is `form`.',
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
          nodes: {
            type: 'array',
            description: 'Canvas nodes the user arranges; required when `kind` is `canvas`.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: 'Stable node identity the edges reference by.' },
                label: { type: 'string', required: true, description: 'Node heading shown inside the node card.' },
                detail: { type: 'string', description: 'Optional secondary text under the label.' },
                role: { type: 'string', enum: ['start', 'end'], description: 'Optional visual role; absent is a plain card.' },
                position: {
                  type: 'object',
                  required: true,
                  additionalProperties: false,
                  properties: {
                    x: { type: 'number', required: true, description: 'Horizontal canvas coordinate.' },
                    y: { type: 'number', required: true, description: 'Vertical canvas coordinate.' },
                  },
                },
              },
            },
          },
          edges: {
            type: 'array',
            description: 'Directed connections between nodes; required when `kind` is `canvas`.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: 'Stable edge identity.' },
                source: { type: 'string', required: true, description: 'Source node id (the outgoing end).' },
                target: { type: 'string', required: true, description: 'Target node id (the incoming end).' },
                label: { type: 'string', description: 'Optional text shown on the connector.' },
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
          pageKind: { type: 'string', required: true, enum: ['form', 'canvas'] },
          fieldCount: { type: 'integer', required: true },
          nodeCount: { type: 'integer', required: true },
          edgeCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.pageKind === 'form'
          ? `Rendered A2UI surface ${value.surfaceId} with ${value.fieldCount} fields.`
          : `Rendered A2UI surface ${value.surfaceId} with ${value.nodeCount} nodes and ${value.edgeCount} edges.`,
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
      const value: {
        surfaceId: string
        accepted: boolean
        pageKind: A2uiPageKind
        fieldCount: number
        nodeCount: number
        edgeCount: number
      } = page.kind === 'form'
        ? { surfaceId, accepted: true, pageKind: 'form', fieldCount: page.fields.length, nodeCount: 0, edgeCount: 0 }
        : { surfaceId, accepted: true, pageKind: 'canvas', fieldCount: 0, nodeCount: page.nodes.length, edgeCount: page.edges.length }
      return Promise.resolve(value)
    },
    presentCall: args => ({ card: 'generic', title: 'Render A2UI page', kind: 'other', rawInput: args.page }),
  }))
}
