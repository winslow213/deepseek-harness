/**
 * Local persistence for model-authored A2UI pages. The capability
 * `ctx.a2uiStore` saves canonical page definitions (DSL + field logic +
 * actions) as one JSON file per tool under `<harness home>/a2ui-tools/`, so a
 * generated page can be exported, distributed, and re-imported by any
 * deployment. The `a2ui_export` model tool writes a page the model just
 * authored; a client surface (the a2ui panel's export button) reaches the
 * same store over its Remote namespace.
 * @module @deepseek-ai/dsh-tool-a2ui-store
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { A2uiPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import { canonicalizeA2uiPage, type A2uiPageInput } from '@deepseek-ai/dsh-tool-a2ui-surface'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureA2uiToolsDir, listA2uiTools, removeA2uiTool, resolveA2uiToolsDir, saveA2uiTool } from './store.ts'
import type { A2uiToolRecord } from './store.ts'
import { A2uiStoreController, A2uiRunController } from './remote.ts'
import { ShellA2uiRun, type A2uiRun } from './run.ts'
import { CodeA2uiRunScript, type A2uiRunScript } from './script.ts'

export type { A2uiToolRecord } from './store.ts'
export { A2UI_TOOLS_DIR, isSafeA2uiToolName, listA2uiTools, removeA2uiTool, resolveA2uiToolsDir, saveA2uiTool } from './store.ts'
export type { A2uiRun, A2uiRunHandle } from './run.ts'
export { fillA2uiCommand } from './run.ts'
export { A2uiStoreController, A2uiRunController } from './remote.ts'
export type {
  A2uiRunReadRequest, A2uiRunReadValue,
  A2uiRunStartRequest, A2uiRunStartValue,
  A2uiRunStopRequest, A2uiRunStopValue,
  A2uiStoreDeleteRequest, A2uiStoreDeleteValue,
  A2uiRunFieldValues,
  A2uiStoreListValue, A2uiStoreOpenRequest, A2uiStoreOpenValue, A2uiToolWire,
} from './types.ts'

/** Cordis plugin name. */
export const name = 'tool-a2ui-store'
/** Required services: the tool registry, the model-facing half of the capability. */
export const inject = ['tools']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The A2UI tool store capability: local persistence for saved pages. */
    a2uiStore: A2uiStore
    /** The A2UI command-run capability: start/read/stop `command` actions over the composed shell service. */
    a2uiRun: A2uiRun
    /** The A2UI script-run capability: run `script` actions on the controlled code runtime. */
    a2uiRunScript: A2uiRunScript
  }
}

/** The store capability every consumer reads from `ctx.a2uiStore`. */
export interface A2uiStore {
  /** The resolved store directory (files live here). */
  readonly dir: string
  /** Every saved tool, name-sorted. */
  list(): Promise<A2uiToolRecord[]>
  /** Persist one canonical page under a stable name, replacing any same-named tool. */
  save(name: string, page: A2uiPage): Promise<A2uiToolRecord>
  /** Remove one saved tool; false when absent. */
  remove(name: string): Promise<boolean>
}

/** A filesystem-backed {@link A2uiStore} over a resolved directory. */
class FileA2uiStore implements A2uiStore {
  constructor(readonly dir: string) {}

  list(): Promise<A2uiToolRecord[]> {
    return listA2uiTools(this.dir)
  }

  save(name: string, page: A2uiPage): Promise<A2uiToolRecord> {
    return saveA2uiTool(this.dir, name, page)
  }

  remove(name: string): Promise<boolean> {
    return removeA2uiTool(this.dir, name)
  }
}

/** Validated plugin configuration. */
export interface Config {
  /** Store directory; defaults to `<harness home>/a2ui-tools`. */
  dir?: string
}

/** Schemastery configuration for the store consumer. */
export const Config: z<Config> = z.object({
  dir: z.string(),
})

const EXPORT_DESCRIPTION = 'Save an A2UI page you authored as a reusable tool file '
  + 'under the local tool store. The page is the same declarative JSON the '
  + '`a2ui_surface` tool renders — `kind`, `title`, and the form `fields` (with '
  + 'their `visibleWhen`/`validateWhen`/`compute` logic) or canvas `nodes`/`edges`, '
  + 'plus optional `actions`. Once saved, the tool is listed in the sidebar for '
  + 'any member to reopen without re-authoring it. Give the tool a short, stable '
  + '`name` that will appear in that list.'

/**
 * Register the store capability and the `a2ui_export` model tool.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - optional store directory override.
 */
export function apply(ctx: Context, config: Config): void {
  const dir = resolveA2uiToolsDir(config.dir)
  const store = new FileA2uiStore(dir)
  ctx.provide('a2uiStore', store)
  ctx.provide('a2uiRun', new ShellA2uiRun(ctx))
  ctx.provide('a2uiRunScript', new CodeA2uiRunScript(ctx))
  void ensureA2uiToolsDir(dir).catch(() => {
    // The first save also creates the directory; a boot-time mkdir failure
    // here must not crash the harness for a directory the next write creates.
  })
  // The Remote namespace (`ctx.remote.a2uiStore`) lets a client sidebar list
  // and re-open saved tools; its services (`a2uiStore`, `agents`, `typert`) are
  // base-plane, so the controller mounts beside the capability.
  ctx.plugin(A2uiStoreController)
  // The `a2uiRun` namespace drives `command` actions from the page's opener.
  ctx.plugin(A2uiRunController)

  ctx.tools.register(defineTool({
    name: 'a2ui_export',
    description: EXPORT_DESCRIPTION,
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Stable tool name for the saved file (letters, digits, dot, dash, underscore; no path separators).',
      },
      page: {
        type: 'json',
        required: true,
        description: 'The declarative A2UI page to save: the same shape as `a2ui_surface`\'s `page` argument.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          saved: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Saved A2UI tool "${value.name}" to the local tool store.`,
      }],
    },
    async execute(args, exec) {
      if (!exec.agent) {
        throw new Error('a2ui_export requires an owning agent session')
      }
      const page = canonicalizeA2uiPage(args.page as unknown as A2uiPageInput)
      const record = await ctx.a2uiStore.save(args.name, page)
      return { name: record.name, saved: true }
    },
    presentCall: args => ({ card: 'generic', title: 'Export A2UI tool', kind: 'other', rawInput: { name: args.name } }),
  }))
}
