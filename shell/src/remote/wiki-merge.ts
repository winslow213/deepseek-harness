/**
 * Model wiring and trigger entry points for the wiki v2 merge
 * (`wiki-v2-实施规格.md` §5, §10 S3/S4).
 *
 * Kept separate from `oplog.ts` on purpose: `oplog.ts` is a dependency-free
 * module that knows nothing about cordis or the LLM seam, which is what lets
 * its whole test suite run against stubs with no model and no plugin host.
 * This file is the thin adapter that supplies what it deliberately left
 * injected — a real completion, a real clock, and the trigger points.
 *
 * Like `wiki-tool.ts`, this is copied into `<profileDir>/plugins/wiki/` at
 * provisioning time and loaded from there, so its `@deepseek-ai/*` imports
 * resolve against the user's profile rather than this source tree.
 *
 * @module dsh-team-shell/wiki-merge
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  DEFAULT_ROTATE_BYTES,
  performMerge,
  rotateIfNeeded,
  type MergeCompletion,
  type MergeOutcome,
  type OpLayer,
} from './oplog.ts'

/** Tags wrapping a merge model's output, mirroring the compaction checkpoint framing. */
const MERGE_OPEN = '<wiki-profile>'
const MERGE_CLOSE = '</wiki-profile>'

/** Which provider/model a merge call should use, resolved from the live session. */
interface MergeTarget {
  readonly provider: string
  readonly model: string
}

/**
 * Resolve the provider/model a merge should call. Prefers the session's most
 * recently routed request, which is the same target the conversation itself
 * is using and therefore guaranteed to be configured and reachable; falls
 * back to the agent's own configured options for a session that has not
 * routed anything yet.
 * @param agent - the session requesting the merge.
 * @returns the target, or `undefined` when neither source names one.
 */
function resolveMergeTarget(agent: Agent): MergeTarget | undefined {
  const latest = agent.session.requestHeader()?.config
  if (latest !== undefined && latest.provider.length > 0 && latest.model.length > 0) {
    return { provider: latest.provider, model: latest.model }
  }
  const provider = agent.options.provider
  const model = agent.options.model
  if (provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0) {
    return { provider, model }
  }
  return undefined
}

/** Strip the output framing if the model wrapped its answer, and drop code fences. */
function unwrapProfileText(raw: string): string {
  const tagged = new RegExp(`${MERGE_OPEN}\\s*([\\s\\S]*?)\\s*${MERGE_CLOSE}`).exec(raw)
  let text = tagged?.[1] ?? raw
  const fenced = /^\s*```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/.exec(text)
  if (fenced?.[1] !== undefined) text = fenced[1]
  return text.trim()
}

/**
 * Build the completion {@link performMerge} calls: one streaming LLM request
 * per layer, assembled into the merged layer text.
 *
 * The prompt is delivered as a plain user message rather than as a separate
 * system prompt, matching how `compaction-basic` frames its auxiliary calls —
 * keeping the model's own instructions out of the merge request is what stops
 * an unrelated task's persona from leaking into the user's profile.
 * @param ctx - the plugin context carrying the `llm` service.
 * @param agent - the session whose provider/model and id the request uses.
 * @param signal - optional cancellation for a merge being abandoned.
 * @returns a completion, or `undefined` when no target is resolvable.
 */
export function createLlmCompletion(
  ctx: Context,
  agent: Agent,
  signal?: AbortSignal,
): MergeCompletion | undefined {
  const target = resolveMergeTarget(agent)
  if (target === undefined) return undefined
  return async (prompt: string, _layer: OpLayer): Promise<string> => {
    const assembler = new BlockAssembler()
    const options = {
      provider: target.provider,
      model: target.model,
      messages: [createUserMessage({
        content: [{ type: 'text' as const, text: prompt }],
        source: { kind: 'plugin' as const, plugin: 'dsh-team-shell/wiki-merge' },
      })],
      maxTokens: 4096,
      sessionId: agent.session.id,
      // `purpose` is deliberately left unset: it is a closed union of core
      // classifications ('compaction' | 'session-title'), and this tree is
      // deployed as a standalone copy outside the workspace, so it must not
      // depend on a widened core API. Left unset it is a legal auxiliary call.
      ...signal === undefined ? {} : { signal },
    }
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
    const text = assembler.blocks()
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (text.trim() === '') throw new Error('wiki merge produced no text')
    return unwrapProfileText(text)
  }
}

/** Options for the trigger helpers, all optional so callers pass only what they vary. */
export interface TriggerOptions {
  /** Bypass the weight threshold (the manual path). */
  readonly force?: boolean
  /** Override the merge weight threshold. */
  readonly threshold?: number
  /** Override the pending-op ceiling. */
  readonly maxPendingOps?: number
  /** Rotate once `ops.jsonl` exceeds this many bytes. */
  readonly rotateBytes?: number
  /** Optional cancellation. */
  readonly signal?: AbortSignal
}

/**
 * Rotate the op stream if it has grown past its threshold. Per spec §7 this
 * is independent of merging: it archives only, takes no lock, and is safe to
 * call from the same post-write hook.
 * @param workspaceRoot - the account's private workspace root.
 * @param options.rotateBytes - rotation threshold, or the module default.
 * @returns whether a rotation happened.
 */
export function maybeRotate(workspaceRoot: string, options: TriggerOptions = {}): boolean {
  return rotateIfNeeded(workspaceRoot, options.rotateBytes ?? DEFAULT_ROTATE_BYTES).rotated
}

/**
 * Run one merge to completion, awaiting the model. Used by the manual
 * `wiki_merge` tool, where the model asked for the merge and should get a
 * real result back (how many ops were folded in, and why it did not merge
 * when it did not).
 *
 * Returns `{ merged: false, reason: 'no-model' }` when no provider/model can
 * be resolved — a merge is never attempted against an unknown target.
 * @param ctx - the plugin context carrying the `llm` service.
 * @param agent - the session requesting the merge.
 * @param workspaceRoot - the account's private workspace root.
 * @param options - trigger overrides.
 * @returns what the merge did.
 */
export async function runMerge(
  ctx: Context,
  agent: Agent,
  workspaceRoot: string,
  options: TriggerOptions = {},
): Promise<MergeOutcome | { merged: false; reason: 'no-model' }> {
  const complete = createLlmCompletion(ctx, agent, options.signal)
  if (complete === undefined) return { merged: false, reason: 'no-model' }
  return performMerge(workspaceRoot, complete, options)
}

/**
 * Fire-and-forget merge for the automatic triggers. Deliberately does not
 * await (spec §5.3): the write path must never block on a model call, and a
 * merge interrupted by process exit is acceptable because the next trigger
 * retries from the same durable state.
 *
 * All outcomes are logged and swallowed. An automatic merge failing is not
 * the caller's problem and must never surface as an error in a `wiki_note`
 * result or disturb session teardown.
 * @param ctx - the plugin context carrying the `llm` service.
 * @param agent - the session whose provider/model the merge uses.
 * @param workspaceRoot - the account's private workspace root.
 * @param options - trigger overrides.
 */
export function scheduleMerge(
  ctx: Context,
  agent: Agent,
  workspaceRoot: string,
  options: TriggerOptions = {},
): void {
  void runMerge(ctx, agent, workspaceRoot, options).then(
    (outcome) => {
      if (outcome.merged) {
        ctx.logger.info(`wiki-merge: folded ${String(outcome.opsMerged ?? 0)} op(s), offset ${String(outcome.offset ?? 0)}`)
        return
      }
      // 'idle' and 'below-threshold' are the common, expected outcomes.
      if (outcome.reason !== 'idle' && outcome.reason !== 'below-threshold') {
        ctx.logger.warn(`wiki-merge: not merged (${outcome.reason})`)
      }
    },
    (error: unknown) => {
      ctx.logger.warn('wiki-merge: automatic merge failed')
      ctx.logger.warn(error)
    },
  )
}
