/**
 * Host execution of A2UI `script` actions. A script is a small async program
 * the model authors into the page; it runs on the composed controlled code
 * runtime (`ctx.codeRuntime`, the worker-thread backend in the web profile),
 * never in the browser and never in the host process. The program may call
 * only the `a2ui.*` members its `binds` grant — each grant maps to one pure
 * host helper, so a script can fetch or reshape data without ever receiving
 * an ambient capability. The completion value and any logs cross the
 * runtime's lossless JSON boundary and become the action result.
 * @module @deepseek-ai/dsh-tool-a2ui-store/script
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CodeBindingNamespace, CodeJsonValue } from '@deepseek-ai/dsh-code-runtime'
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

/** All granted binding helpers, by member name. */
const BINDINGS: Record<A2uiScriptBinding, (args: unknown) => Promise<CodeJsonValue>> = {
  fetch: async (_args) => {
    throw new Error('a2ui.fetch is not granted in this deployment yet')
  },
  text: async (args) => {
    const value = typeof args === 'string' ? args : JSON.stringify(args)
    return String(value).toUpperCase()
  },
}

/** Build the one namespace a script sees, from only the granted members. */
function bindingNamespaces(binds: readonly A2uiScriptBinding[]): CodeBindingNamespace[] {
  const functions: Record<string, (args: unknown) => Promise<CodeJsonValue>> = {}
  for (const name of binds) {
    const fn = BINDINGS[name]
    if (fn !== undefined) functions[name] = fn
  }
  return [{ global: 'a2ui', functions }]
}

/**
 * The code-runtime-backed script capability registered on `ctx.a2uiRunScript`.
 * The code runtime is resolved lazily so the plugin mounts in compositions
 * without one; only an actual script run needs it.
 */
export class CodeA2uiRunScript implements A2uiRunScript {
  /** @param ctx - registrant context that may acquire the code runtime. */
  constructor(private readonly ctx: Context) {}

  async run(program: string, binds: readonly A2uiScriptBinding[], _fields: A2uiRunFieldValues): Promise<A2uiScriptResult> {
    const runtime = this.ctx.get('codeRuntime')
    if (runtime === undefined) {
      throw new Error('a2uiRunScript: no code runtime is mounted; a `script` action cannot run')
    }
    const result = await runtime.run({
      program,
      bindings: bindingNamespaces(binds),
    })
    return {
      ...result.value === undefined ? {} : { value: result.value },
      logs: result.logs,
      ...result.error === undefined ? {} : { error: { kind: result.error.kind, message: result.error.message } },
    }
  }
}
