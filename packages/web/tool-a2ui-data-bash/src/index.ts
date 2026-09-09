/**
 * Bash-backed A2UI dynamic data-source provider: resolves a stable source
 * name into a `select` field's options by running one operator-configured
 * command through the composed `shell` service. The command whitelist is the
 * deployment's explicit, validated surface — the model (through the page DSL)
 * only ever names a `source`, never supplies a command — so a page cannot
 * reach arbitrary host execution through the data-source channel.
 * @module @deepseek-ai/dsh-tool-a2ui-data-bash
 */

import type { Context } from '@deepseek-ai/cordis'
import type { A2uiFieldOption } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import { A2uiDataController } from '@deepseek-ai/dsh-tool-a2ui-data'
import type { A2uiDataProvider, A2uiDataSourceArgs, A2uiDataSourceResult } from '@deepseek-ai/dsh-tool-a2ui-data'
import type {} from '@deepseek-ai/dsh-shell'
import z from '@deepseek-ai/schemastery'

export const name = 'tool-a2ui-data-bash'

/** Required services: the shell executor and the Remote namespace carrier. */
export const inject = ['shell']

/** One whitelisted source: the operator-authored command and its run bound. */
export interface A2uiDataSourceSpec {
  /**
   * Shell command producing the options. May use `{fieldName}` placeholders
   * filled from the collected field values; every placeholder must name a
   * field (an unknown one fails loud).
   */
  readonly command: string
  /** Run bound in milliseconds; absent uses the shell default and cap. */
  readonly timeoutMs?: number
}

/** Provider configuration: the source-name → command whitelist. */
export interface Config {
  /** Source name → operator-authored command; a page may only name a key here. */
  readonly sources: Record<string, A2uiDataSourceSpec>
}

export const Config: z<Config> = z.object({
  sources: z.dict(z.object({
    command: z.string(),
    timeoutMs: z.number().step(1).min(1).max(600_000),
  })).default({}),
})

/** Cap the provider's stdout read: an option list is small, and a runaway command spills. */
const STDOUT_MAX_BYTES = 1024 * 1024

/** Wrap one value as a POSIX single-quoted shell word so it cannot splice syntax. */
function shellQuote(value: string | number | boolean | null): string {
  const text = value === null ? '' : String(value)
  return `'${text.replaceAll("'", "'\\''")}'`
}

/**
 * Fill `{name}` placeholders in a source command. A placeholder names a
 * field; a name with no field value (null) becomes the empty word. An unknown
 * placeholder fails loud instead of running a partially substituted command.
 * @param command - the operator-authored command template.
 * @param args - the collected field values to substitute.
 * @returns the filled command.
 */
export function fillCommand(command: string, args: A2uiDataSourceArgs): string {
  return command.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    if (!(name in args)) {
      throw new Error(`a2ui data source: placeholder {${name}} has no matching field`)
    }
    return shellQuote(args[name] ?? null)
  })
}

/**
 * Convert a source command's stdout into select options. Accepts a JSON
 * array of `{label,value}` records or `{ items: [...] }`; a non-JSON output
 * is split into non-empty lines, each becoming one option whose label and
 * value are the trimmed line. Invalid entries are skipped.
 * @param stdout - the command's captured stdout text.
 * @returns the resolved options.
 */
export function parseOptions(stdout: string): A2uiFieldOption[] {
  let source: unknown
  try {
    source = JSON.parse(stdout)
  } catch {
    source = undefined
  }
  const rawItems: unknown[] = Array.isArray(source) ? source
    : source !== null && typeof source === 'object' && Array.isArray((source as { items?: unknown }).items)
      ? (source as { items: unknown[] }).items
      : stdout.split('\n').map(line => ({ label: line.trim(), value: line.trim() }))
  const options: A2uiFieldOption[] = []
  for (const item of rawItems) {
    if (item === null || typeof item !== 'object') continue
    const record = item as { label?: unknown; value?: unknown }
    const label = typeof record.label === 'string' ? record.label : ''
    const value = typeof record.value === 'string' ? record.value : ''
    if (label === '' || value === '') continue
    options.push({ label, value })
  }
  return options
}

/** The shell-service-backed data provider registered on `ctx.a2uiData`. */
export class BashA2uiDataProvider implements A2uiDataProvider {
  /**
   * @param ctx - registrant context that may acquire the shell service.
   * @param sources - the operator-configured source → command whitelist.
   */
  constructor(
    private readonly ctx: Context,
    private readonly sources: Config['sources'],
  ) {}

  has(source: string): boolean {
    return source in this.sources
  }

  async resolve(source: string, args: A2uiDataSourceArgs): Promise<A2uiDataSourceResult> {
    const spec = this.sources[source]
    if (spec === undefined) {
      throw new Error(`a2ui data source: unknown source "${source}"`)
    }
    const shell = this.ctx.get('shell')
    if (shell === undefined) {
      throw new Error('a2ui data source: no shell service is mounted; a source cannot resolve')
    }
    const filled = fillCommand(spec.command, args)
    const resolved = shell.resolve({
      command: filled,
      ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      stdoutMaxBytes: STDOUT_MAX_BYTES,
    })
    const result = await shell.run(resolved)
    if (result.exitCode !== 0) {
      const detail = result.stderr.text.trim()
      throw new Error(`a2ui data source "${source}" failed: exit ${String(result.exitCode)}${detail === '' ? '' : `: ${detail}`}`)
    }
    return { items: parseOptions(result.stdout.text) }
  }
}

/**
 * Register the bash provider on `ctx.a2uiData` and mount the Remote
 * controller beside it.
 * @param ctx - registrant context carrying the shell service.
 * @param config - the source-name → command whitelist.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.provide('a2uiData', new BashA2uiDataProvider(ctx, config.sources))
  ctx.plugin(A2uiDataController)
}
