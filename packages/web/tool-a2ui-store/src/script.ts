/**
 * Host execution of A2UI `script` actions. A script is a small async program
 * the model authors into the page; it runs on the composed controlled code
 * runtime (`ctx.codeRuntime`, the worker-thread backend in the web profile),
 * never in the browser and never in the host process. The program may call
 * only the `a2ui.*` members its `binds` grant — each grant maps to one host
 * helper behind the web capability, so a script can fetch or reshape data
 * without ever receiving an ambient capability.
 *
 * Binding calls are async, so the program must `await a2ui.<name>(...)`
 * before folding the result into its completion value; an un-awaited call
 * leaves a Promise in the value and the run fails the lossless-JSON
 * boundary. The completion value and any logs cross that boundary and become
 * the action result.
 * @module @deepseek-ai/dsh-tool-a2ui-store/script
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CodeBindingFunction, CodeBindingNamespace, CodeJsonValue } from '@deepseek-ai/dsh-code-runtime'
import type { A2uiRunFieldValues, A2uiScriptJson } from './types.ts'

/** One granted binding member a script may call. */
export type A2uiScriptBinding = 'fetch' | 'text'

/** Outcome of one script run. */
export interface A2uiScriptResult {
  /** The program's completion value when it crossed the JSON boundary. */
  readonly value?: A2uiScriptJson
  /** Ordered log lines the program emitted. */
  readonly logs: readonly string[]
  /** Failure detail when the run did not complete. */
  readonly error?: { readonly kind: string; readonly message: string }
}

/** The host script-run capability backing `ctx.a2uiRunScript`. */
export interface A2uiRunScript {
  /**
   * Run one script program with only its granted bindings on the composed
   * code runtime.
   * @param program - the async program body.
   * @param binds - granted `a2ui.*` member names the program may call.
   * @param fields - collected field values (not directly bound; a script that
   *   needs them should embed them, or a later revision binds them by name).
   * @returns the run outcome.
   * @throws when no code runtime is mounted or a program/environment error.
   */
  run(program: string, binds: readonly A2uiScriptBinding[], fields: A2uiRunFieldValues): Promise<A2uiScriptResult>
}

/** The single argument shape `a2ui.fetch` accepts. */
interface FetchArgs {
  readonly url: string
}

/** Whether one host helper is granted. */
function grant(name: string): name is A2uiScriptBinding {
  return name === 'fetch' || name === 'text'
}

/** Uppercase the string form of one JSON value (deterministic pure helper). */
function textHelper(value: CodeJsonValue): CodeJsonValue {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.toUpperCase()
}

/** The `fetch` helper surfaced through the web capability. */
type WebFetchOutcome = {
  statusCode: number
  body: { kind: string; content: string }
  url: string
  truncated: boolean
}

/** The `fetch` helper surfaced through the web capability. */
function fetchHelper(fn: (request: { url: string }) => Promise<WebFetchOutcome>): CodeBindingFunction {
  return async (args: unknown): Promise<CodeJsonValue> => {
    const request = args as FetchArgs
    if (typeof request?.url !== 'string' || !/^https?:\/\//.test(request.url)) {
      throw new Error('a2ui.fetch: expected an `http(s)://` url')
    }
    const result = await fn({ url: request.url })
    return {
      url: result.url,
      statusCode: result.statusCode,
      kind: result.body.kind,
      content: result.body.content,
      truncated: result.truncated,
    }
  }
}

/**
 * The code-runtime-backed script capability registered on `ctx.a2uiRunScript`.
 * The code runtime and the web service are resolved lazily so the plugin
 * mounts in compositions without them; only an actual script run needs one.
 */
export class CodeA2uiRunScript implements A2uiRunScript {
  /** @param ctx - registrant context that may acquire the code runtime and web service. */
  constructor(private readonly ctx: Context) {}

  private async bindingFunctions(binds: readonly A2uiScriptBinding[]): Promise<Record<string, CodeBindingFunction>> {
    const functions: Record<string, CodeBindingFunction> = {}
    for (const name of binds) {
      if (!grant(name)) continue
      if (name === 'text') {
        functions.text = async args => textHelper(args as CodeJsonValue)
        continue
      }
      // fetch
      const web = this.ctx.get('web')
      if (web === undefined) {
        throw new Error('a2uiRunScript: no web service is mounted; a `fetch` binding cannot run')
      }
      functions.fetch = fetchHelper(async (request) => {
        const result = await web.fetch({ url: request.url })
        return {
          url: result.url,
          statusCode: result.statusCode,
          body: result.body,
          truncated: result.truncated,
        }
      })
    }
    return functions
  }

  async run(program: string, binds: readonly A2uiScriptBinding[], _fields: A2uiRunFieldValues): Promise<A2uiScriptResult> {
    const runtime = this.ctx.get('codeRuntime')
    if (runtime === undefined) {
      throw new Error('a2uiRunScript: no code runtime is mounted; a `script` action cannot run')
    }
    const functions = await this.bindingFunctions(binds)
    const namespaces: CodeBindingNamespace[] = [{ global: 'a2ui', functions }]
    const result = await runtime.run({
      program,
      bindings: namespaces,
    })
    return {
      ...result.value === undefined ? {} : { value: result.value },
      logs: result.logs,
      ...result.error === undefined ? {} : { error: { kind: result.error.kind, message: result.error.message } },
    }
  }
}
