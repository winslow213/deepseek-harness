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
  A2uiAction, A2uiCanvasEdge, A2uiCanvasNode, A2uiCanvasPage, A2uiField, A2uiPage, A2uiPageKind,
} from './types.ts'

export type * from './types.ts'

export const name = 'tool-a2ui-surface'
export const inject = ['tools']

/** The valid {@link A2uiField} widget kinds, as a runtime set for input narrowing. */
export const FIELD_TYPES = ['text', 'textarea', 'select', 'number', 'checkbox'] as const

/** The model-supplied page shape, already schema-checked, before canonicalization. */
export interface A2uiPageInput {
  kind: A2uiPageKind
  title: string
  description?: string
  submitLabel?: string
  instruction?: string
  fields?: A2uiField[]
  nodes?: A2uiCanvasNode[]
  edges?: A2uiCanvasEdge[]
  actions?: A2uiAction[]
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
  + '`instruction` tells the user what will happen with the submitted values. '
  + 'Fields may carry restricted, side-effect-free expressions for live logic: '
  + '`visibleWhen` hides the field while a sibling-field expression is falsy, '
  + '`validateWhen` (with `validateMessage`) refuses submit while its expression '
  + 'is falsy, and `compute` makes the field read-only and displays a derived '
  + 'value. Expressions reference sibling fields by bare `name` and support '
  + 'string/number/boolean/null literals, `=== !== == != < <= > >= && || ! + - '
  + '* / %`, parentheses, and `.length`/`.trim()`/`.includes(x)`/'
  + '`.startsWith(x)`/`.endsWith(x)`. To expose operations, add `actions`: each '
  + 'is an `id`, a `label`, and an `execution` mode. `execution: "model"` '
  + '(the default) names a `tool` and an `instruction`, and when the user '
  + 'clicks it you receive an action trigger with the collected values and '
  + 'should invoke that tool with them. `execution: "local"` runs in the '
  + 'browser with no model round-trip: give it a `result` expression (over '
  + 'the collected values, same grammar as field logic) shown to the user '
  + 'after the click. Use `local` for deterministic, side-effect-free '
  + 'transformations and `model` only when the action needs reasoning or a '
  + 'real tool call.'

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
 * known field `type` and node `role` values, and for `canvas` pages unique
 * node ids with finite positions plus edges whose endpoints reference
 * existing nodes. The registry has already enforced the enums and rejected
 * unknown keys (`additionalProperties: false` — the logged page must equal
 * what the model believes it wrote, so a nested or extended shape fails loud
 * at the schema boundary); the casts below record that guarantee. The enum
 * checks are re-asserted here so a caller that canonicalizes a page outside
 * the registry schema (the a2ui tool store) still rejects an unknown field
 * or node-role value.
 * @param raw - the model-supplied page, already schema-checked.
 * @returns the canonical page.
 */
export function canonicalizeA2uiPage(raw: A2uiPageInput): A2uiPage {
  const title = raw.title.trim()
  if (title.length === 0) throw new Error('invalid a2ui page: `title` must be a non-empty string')
  const actions = toA2uiActions(raw.actions ?? [])
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
      ...actions.length === 0 ? {} : { actions },
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
    ...actions.length === 0 ? {} : { actions },
  }
}

/** Canonicalize the model-supplied action list, preserving the existing constraints. */
function toA2uiActions(rawActions: readonly A2uiAction[]): A2uiAction[] {
  const seen = new Set<string>()
  const actions: A2uiAction[] = []
  for (const action of rawActions) {
    const id = action.id.trim()
    const label = action.label.trim()
    const execution = action.execution === undefined ? 'model' : action.execution
    if (id.length === 0) throw new Error('invalid a2ui action: `id` must be a non-empty string')
    if (label.length === 0) throw new Error(`invalid a2ui action ${JSON.stringify(id)}: \`label\` must be a non-empty string`)
    if (execution === 'model') {
      const tool = action.tool?.trim() ?? ''
      const instruction = action.instruction?.trim() ?? ''
      if (tool.length === 0) throw new Error(`invalid a2ui action ${JSON.stringify(id)}: a \`model\` action must name a \`tool\``)
      if (instruction.length === 0) throw new Error(`invalid a2ui action ${JSON.stringify(id)}: a \`model\` action must carry an \`instruction\``)
      if (seen.has(id)) throw new Error(`invalid a2ui page: duplicate action id ${JSON.stringify(id)}`)
      seen.add(id)
      actions.push({ id, label, execution: 'model', tool, instruction })
    } else if (execution === 'command') {
      const command = action.command?.trim() ?? ''
      const timeoutMs = action.timeoutMs
      if (command.length === 0) throw new Error(`invalid a2ui action ${JSON.stringify(id)}: a \`command\` action must carry a \`command\``)
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        throw new Error(`invalid a2ui action ${JSON.stringify(id)}: \`timeoutMs\` must be a positive number`)
      }
      if (seen.has(id)) throw new Error(`invalid a2ui page: duplicate action id ${JSON.stringify(id)}`)
      seen.add(id)
      actions.push({
        id,
        label,
        execution: 'command',
        command,
        ...timeoutMs === undefined ? {} : { timeoutMs },
      })
    } else if (execution === 'script') {
      const program = action.program?.trim() ?? ''
      const binds = action.binds ?? []
      const grantable = new Set(['fetch', 'text'])
      const unknown = binds.filter(name => !grantable.has(name))
      if (program.length === 0) throw new Error(`invalid a2ui action ${JSON.stringify(id)}: a \`script\` action must carry a \`program\``)
      if (unknown.length > 0) {
        throw new Error(`invalid a2ui action ${JSON.stringify(id)}: unknown \`binds\` ${JSON.stringify(unknown)} (grantable: fetch, text)`)
      }
      if (seen.has(id)) throw new Error(`invalid a2ui page: duplicate action id ${JSON.stringify(id)}`)
      seen.add(id)
      const write = action.write
      if (write !== undefined) {
        for (const entry of write) {
          const field = entry.field.trim()
          const from = entry.from.trim()
          if (field.length === 0) throw new Error(`invalid a2ui action ${JSON.stringify(id)}: \`write\` field must be non-empty`)
          if (from.length === 0) throw new Error(`invalid a2ui action ${JSON.stringify(id)}: \`write\` selector for ${JSON.stringify(field)} must be non-empty`)
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error(`invalid a2ui action ${JSON.stringify(id)}: \`write\` field ${JSON.stringify(field)} must be a field identifier`)
        }
      }
      actions.push({
        id,
        label,
        execution: 'script',
        program,
        ...binds.length === 0 ? {} : { binds: [...binds] },
        ...write === undefined ? {} : { write: write.map(e => ({ field: e.field.trim(), from: e.from.trim() })) },
      })
    } else {
      if (seen.has(id)) throw new Error(`invalid a2ui page: duplicate action id ${JSON.stringify(id)}`)
      seen.add(id)
      actions.push({
        id,
        label,
        execution: 'local',
        ...action.result === undefined || action.result.trim().length === 0 ? {} : { result: action.result.trim() },
      })
    }
  }
  return actions
}

/** Trim one model-supplied expression, rejecting blank text. */
function toA2uiExpression(value: string | undefined, owner: string, key: string): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`invalid a2ui ${owner}: \`${key}\` must be a non-empty expression`)
  return trimmed
}

/** Canonicalize the model-supplied field list, preserving the existing constraints. */
function toA2uiFields(rawFields: readonly A2uiField[]): A2uiField[] {
  const seen = new Set<string>()
  const fields: A2uiField[] = []
  for (const field of rawFields) {
    const name = field.name.trim()
    const label = field.label.trim()
    if (name.length === 0) throw new Error('invalid a2ui field: `name` must be a non-empty string')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid a2ui field ${JSON.stringify(name)}: \`name\` must be a plain identifier (letters, digits, underscore; not starting with a digit)`)
    }
    if (label.length === 0) throw new Error(`invalid a2ui field ${JSON.stringify(name)}: \`label\` must be a non-empty string`)
    if (seen.has(name)) throw new Error(`invalid a2ui page: duplicate field name ${JSON.stringify(name)}`)
    seen.add(name)
    if (!(FIELD_TYPES as readonly string[]).includes(field.type)) {
      throw new Error(`invalid a2ui field ${JSON.stringify(name)}: unknown type ${JSON.stringify(field.type)}`)
    }
    if (field.type === 'select' && (field.options === undefined || field.options.length === 0)) {
      throw new Error(`invalid a2ui field ${JSON.stringify(name)}: a \`select\` field needs at least one option`)
    }
    const visibleWhen = toA2uiExpression(field.visibleWhen, `field ${JSON.stringify(name)}`, 'visibleWhen')
    const validateWhen = toA2uiExpression(field.validateWhen, `field ${JSON.stringify(name)}`, 'validateWhen')
    const compute = toA2uiExpression(field.compute, `field ${JSON.stringify(name)}`, 'compute')
    if (field.validateMessage !== undefined && validateWhen === undefined) {
      throw new Error(`invalid a2ui field ${JSON.stringify(name)}: \`validateMessage\` needs a \`validateWhen\` expression`)
    }
    if (compute !== undefined && field.required === true) {
      throw new Error(`invalid a2ui field ${JSON.stringify(name)}: a computed field cannot be \`required\``)
    }
    fields.push({
      name,
      label,
      type: field.type,
      ...field.required === undefined ? {} : { required: field.required },
      ...field.placeholder === undefined ? {} : { placeholder: field.placeholder },
      ...field.options === undefined ? {} : { options: field.options },
      ...field.help === undefined ? {} : { help: field.help },
      ...visibleWhen === undefined ? {} : { visibleWhen },
      ...validateWhen === undefined ? {} : { validateWhen },
      ...validateWhen === undefined ? {} : { validateMessage: field.validateMessage },
      ...compute === undefined ? {} : { compute },
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
                visibleWhen: { type: 'string', description: 'Restricted expression over sibling field names; the field is hidden while it is falsy.' },
                validateWhen: { type: 'string', description: 'Restricted expression over sibling field names; when set it must be truthy at submit.' },
                validateMessage: { type: 'string', description: 'Failure message shown when validateWhen is falsy at submit.' },
                compute: { type: 'string', description: 'Restricted expression over sibling field names; the field becomes read-only and displays its result.' },
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
          actions: {
            type: 'array',
            description: 'Declarative actions rendered as buttons beside the submit control; each runs locally (`local`) or triggers a model tool call (`model`).',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: 'Stable identity the action trigger payload carries.' },
                label: { type: 'string', required: true, description: 'Button label.' },
                execution: { type: 'string', enum: ['local', 'model', 'command', 'script'], description: 'Execution mode; defaults to `model`. `local` runs in the browser with no model call, `model` invokes `tool`, `command` runs `command` on the harness host, `script` runs `program` on the host controlled runtime.' },
                tool: { type: 'string', description: 'Tool name the model invokes when the action is triggered (required for `model` mode).' },
                instruction: { type: 'string', description: 'What invoking the tool accomplishes; the model uses this to form the call (required for `model` mode).' },
                result: { type: 'string', description: 'Expression over the collected values shown after a `local` action runs.' },
                command: { type: 'string', description: 'Shell command template with `{fieldName}` placeholders filled from the collected values (required for `command` mode).' },
                timeoutMs: { type: 'number', description: 'Run bound in milliseconds for a `command` action; absent uses the host shell default and cap.' },
                program: { type: 'string', description: 'Async program body run on the host controlled runtime when the action is triggered (required for `script` mode). The body calls granted `a2ui.*` bindings and returns a JSON value.' },
                binds: { type: 'array', description: 'Granted `a2ui.*` binding member names for a `script` action (`fetch`, `text`).', items: { type: 'string' } },
                write: { type: 'array', description: 'Write-back entries applied after a `script`/`command` action completes: each names a target `field` and a dotted selector `from` into the outcome JSON (`value` or `value.<path>`).', items: { type: 'object', additionalProperties: false, properties: { field: { type: 'string', required: true }, from: { type: 'string', required: true } } } },
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
      const page = canonicalizeA2uiPage(args.page)
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
