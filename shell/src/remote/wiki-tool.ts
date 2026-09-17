/**
 * `wiki_note` tool: the model-facing write path for a user's four-layer
 * personal wiki (identity/preferences/timeline/decisions), plus a periodic
 * `<system-reminder>` nudge so a long session does not forget the tool
 * exists. This file has no build of its own: it is copied verbatim (with its
 * `wiki-fs.ts`, `oplog.ts`, and `wiki-merge.ts` siblings) into
 * `<profileDir>/plugins/wiki/` by `writeTeamUserWikiPatch` in
 * `../spawn-user.ts` and loaded by cordis from that copy at runtime, the same
 * way `../remote/region-router.ts` is.
 *
 * Config `wikiV2` selects the write path and defaults ON: identity/preferences
 * calls record a `baseline` op (an authoritative full-layer snapshot), render
 * the pending block, and merge on the weighted trigger (spec §5, §11.3).
 * Setting it `false` restores the v1 whole-file overwrite and its conflict
 * check, which is the documented rollback.
 *
 * @module dsh-team-shell/wiki-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scaffoldUserWiki, readWikiLayer, writeWikiLayer, WikiWriteConflictError, type WikiLayer, type WholeReplaceWikiLayer } from './wiki-fs.ts'
import {
  appendOp,
  baselineOp,
  DEFAULT_MERGE_WEIGHT_THRESHOLD,
  DEFAULT_MAX_PENDING_OPS,
  DEFAULT_ROTATE_BYTES,
  renderPendingIntoProfiles,
} from './oplog.ts'
import { maybeRotate, runMerge, scheduleMerge } from './wiki-merge.ts'

export const name = 'tool-wiki'
export const inject = ['agents', 'tools']

/** Model-facing `wiki_note` tool configuration. */
export interface Config {
  /** The account's private workspace root the four wiki files live under. */
  workspaceRoot: string
  /** Re-inject the reminder every this many `agent/pre-step` calls (default 6). */
  reminderEveryTurns?: number
  /**
   * Record identity/preferences writes in the op stream and merge on the
   * weighted trigger, instead of overwriting the layer file whole (spec
   * §11.3). Defaults to `true`; set `false` to restore the v1 overwrite path.
   */
  wikiV2?: boolean
  /** Accumulated weight at which a merge becomes warranted (spec §5.2). */
  mergeWeightThreshold?: number
  /** Unmerged-op count that forces a merge regardless of weight (spec §5.5). */
  maxPendingOps?: number
  /** Rotate `ops.jsonl` into the archive past this many bytes (spec §7). */
  rotateBytes?: number
}

/** Schemastery configuration for the wiki-note tool consumer. */
export const Config: z<Config> = z.object({
  workspaceRoot: z.string().required(),
  reminderEveryTurns: z.number().step(1).min(1).default(6),
  wikiV2: z.boolean().default(true),
  mergeWeightThreshold: z.number().step(1).min(1).default(DEFAULT_MERGE_WEIGHT_THRESHOLD),
  maxPendingOps: z.number().step(1).min(1).default(DEFAULT_MAX_PENDING_OPS),
  rotateBytes: z.number().step(1).min(1).default(DEFAULT_ROTATE_BYTES),
})

const LAYERS = ['identity', 'preferences', 'timeline', 'decision'] as const

/** Source tag for the periodic `wiki_note` reminder message. */
export interface WikiReminderSource {
  readonly kind: 'wiki-reminder'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'wiki-reminder': WikiReminderSource
  }
}

const DESCRIPTION = [
  "Record durable memory about this user in their personal wiki. Use `kind: 'identity'` for",
  'stable facts (name, role, team, long-running goals) and `kind: \'preferences\'` for working',
  'patterns/preferences (tools, style, review habits) — both REPLACE the whole layer with',
  '`content` (send the full text, not a diff). Use `kind: \'timeline\'` the moment a conversation',
  'reaches a real breakthrough or milestone, and `kind: \'decision\'` whenever you or the user make',
  'a consequential call — both APPEND a new dated entry and never rewrite an earlier one; to',
  'reverse a past decision, append a new entry that says which earlier one it supersedes.',
  "`decision` calls should also send `alternativesConsidered` (what else was weighed and why it",
  "lost) and `decidedBy`. Skip this tool for routine, forgettable exchanges. An `identity`/",
  "`preferences` call can fail with a conflict error if another of this user's sessions wrote to",
  "the same layer in between — the error includes the latest on-disk content; merge your intended",
  "change into it and call wiki_note again with the merged full text.",
].join(' ')

/** `wiki_note` description under the op-stream write path (spec §11.1). */
const DESCRIPTION_V2 = [
  "Record durable memory about this user in their personal wiki. Use `kind: 'identity'` for",
  "stable facts (name, role, team, long-running goals) and `kind: 'preferences'` for working",
  'patterns/preferences (tools, style, review habits). For these two, send the full updated text',
  'for the layer; your call is recorded as an authoritative snapshot and folded into the stored',
  'profile, so nothing another session recorded is lost. Use `kind: \'timeline\'` the moment a',
  "conversation reaches a real breakthrough or milestone, and `kind: 'decision'` whenever you or",
  'the user make a consequential call — both APPEND a new dated entry and never rewrite an earlier',
  'one; to reverse a past decision, append a new entry that says which earlier one it supersedes.',
  "`decision` calls should also send `alternativesConsidered` (what else was weighed and why it",
  "lost) and `decidedBy`. Skip this tool for routine, forgettable exchanges. Newly recorded facts",
  'may appear in a `PENDING-OPS` block at the end of the layer file until they are merged; that',
  'block is bookkeeping, not content, and disappears on its own.',
].join(' ')

/** Render the periodic nudge reminding the model the tool exists and when to use it. */
function renderReminder(): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    source: { kind: 'wiki-reminder' },
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        "Reminder: if this session has reached a notable breakthrough, a durable decision, or a",
        "new stable fact/preference about the user since the last note, call `wiki_note` now to",
        "record it before continuing. If nothing durable has happened yet, ignore this reminder.",
        '</system-reminder>',
      ].join('\n'),
    }],
  })
}

/**
 * Register `wiki_note` on `ctx.tools` and a per-agent periodic
 * `agent/pre-step` reminder to call it.
 * @param ctx - registrant context carrying the tool and agent-step registries.
 * @param config - the workspace root and reminder cadence.
 */
export function apply(ctx: Context, config: Config): void {
  const workspaceRoot = config.workspaceRoot
  const everyTurns = config.reminderEveryTurns ?? 6
  const v2 = config.wikiV2 ?? true
  const triggerOptions = {
    threshold: config.mergeWeightThreshold ?? DEFAULT_MERGE_WEIGHT_THRESHOLD,
    maxPendingOps: config.maxPendingOps ?? DEFAULT_MAX_PENDING_OPS,
    rotateBytes: config.rotateBytes ?? DEFAULT_ROTATE_BYTES,
  }
  scaffoldUserWiki(workspaceRoot)

  // The session whose provider/model a background merge should use. Captured
  // on every `agent/pre-step` because that is where the agent is handed to us,
  // and because a merge needs a routed request to name a target at all.
  let lastAgent: Agent | undefined
  const rememberAgent = ({ agent }: { agent: Agent }): void => { lastAgent = agent }

  // Cross-session conflict guard for the whole-replace layers (identity/
  // preferences): the account's workspace root is shared by every session
  // this user has open (a shadow-pairing mount and the main session resolve
  // to the same backing files), and each is a separate process with its own
  // `lastSeen`. `refreshLastSeen` snapshots what THIS process currently sees
  // on disk before every model step (mirroring the auto-loaded instruction
  // read the model itself just got); `wiki_note` then refuses to overwrite a
  // layer whose disk content has since diverged from that snapshot — the
  // only way it can diverge is a write from another session in between.
  const lastSeen: Partial<Record<WholeReplaceWikiLayer, string>> = {}
  const refreshLastSeen = (): void => {
    lastSeen.identity = readWikiLayer(workspaceRoot, 'identity')
    lastSeen.preferences = readWikiLayer(workspaceRoot, 'preferences')
  }
  refreshLastSeen()

  ctx.tools.register(defineTool({
    name: 'wiki_note',
    description: v2 ? DESCRIPTION_V2 : DESCRIPTION,
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: [...LAYERS],
        description: 'Which wiki layer this call writes: identity | preferences | timeline | decision.',
      },
      title: {
        type: 'string',
        description: 'Short heading for the entry. Required for `timeline` and `decision`.',
      },
      content: {
        type: 'string',
        required: true,
        description: 'For identity/preferences: the full replacement text. For timeline/decision: the entry body.',
      },
      alternativesConsidered: {
        type: 'string',
        description: 'Decision only: alternatives weighed and why they were rejected.',
      },
      decidedBy: {
        type: 'string',
        enum: ['user', 'model', 'joint'],
        description: 'Decision only: who made the call.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: [...LAYERS] },
        },
      },
      render: (args) => [{ type: 'text', text: `Wiki note recorded (${args.kind}).` }],
    },
    execute(args) {
      const kind = args.kind as WikiLayer
      if ((kind === 'timeline' || kind === 'decision') && (args.title === undefined || args.title.trim() === '')) {
        throw new Error(`wiki_note: \`title\` is required for kind "${kind}"`)
      }
      if (kind === 'decision' && (args.alternativesConsidered === undefined || args.alternativesConsidered.trim() === '')) {
        throw new Error('wiki_note: `alternativesConsidered` is required for kind "decision"')
      }
      if (kind === 'identity' || kind === 'preferences') {
        if (v2) {
          // Recorded, never overwritten: the op stream is the truth and the
          // layer file is derived from it, so a concurrent session's facts
          // cannot be clobbered by this call (the v1 failure this replaces).
          appendOp(workspaceRoot, baselineOp(kind, args.content, sessionOf(lastAgent), new Date(), 'wiki_note full-text call'))
          // Make the fact visible to the model this turn rather than only
          // after a merge, then merge if the accumulated weight warrants it.
          renderPendingIntoProfiles(workspaceRoot)
          maybeRotate(workspaceRoot, triggerOptions)
          if (lastAgent !== undefined) scheduleMerge(ctx, lastAgent, workspaceRoot, triggerOptions)
          return Promise.resolve({ kind })
        }
        try {
          writeWikiLayer(workspaceRoot, kind, { title: '', content: args.content }, lastSeen[kind])
        } catch (err) {
          if (!(err instanceof WikiWriteConflictError)) throw err
          // Surface the real current content so the model can merge instead
          // of silently losing whichever session wrote last; remember it so
          // an immediate retry (same on-disk state) succeeds.
          lastSeen[kind] = err.currentContent
          throw new Error([
            `wiki_note: conflict — another session wrote to this user's ${kind} file after this`,
            'session last read it; nothing was written. Re-read the current content below, merge',
            'in what you intended to add or change, and call wiki_note again with the merged text.',
            '',
            '--- current on-disk content ---',
            err.currentContent,
          ].join('\n'))
        }
        lastSeen[kind] = `${args.content.trim()}\n`
        return Promise.resolve({ kind })
      }
      writeWikiLayer(workspaceRoot, kind, {
        title: args.title ?? '',
        content: args.content,
        alternativesConsidered: args.alternativesConsidered,
        decidedBy: args.decidedBy as 'user' | 'model' | 'joint' | undefined,
      })
      return Promise.resolve({ kind })
    },
  }))

  if (v2) {
    // Manual merge (spec §5.4). Reuses the same gate and merge as the
    // automatic path; only the weight threshold is bypassed, since the model
    // explicitly judged a merge worthwhile. The lock, the fail-safe, and the
    // evidence check all still apply, and unlike the automatic path this one
    // awaits so the model gets a real result.
    ctx.tools.register(defineTool({
      name: 'wiki_merge',
      description: [
        'Fold recorded but not-yet-merged wiki facts into the stored profile now, instead of',
        'waiting for the automatic weighted trigger. Call this after recording something',
        'important if you want it consolidated immediately. Merging is also automatic, so this',
        'is only worth calling when acting on that fact right away matters. If another session',
        'is merging, this returns immediately without waiting and the facts stay recorded.',
      ].join(' '),
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { status: { type: 'string', required: true } },
        },
        // `render`'s first argument is the validated INPUT (empty here); the
        // tool's result is the second.
        render: (_args, value) => [{ type: 'text', text: value.status }],
      },
      async execute() {
        if (lastAgent === undefined) {
          return { status: 'Nothing recorded to merge yet.' }
        }
        const outcome = await runMerge(ctx, lastAgent, workspaceRoot, { ...triggerOptions, force: true })
        if (outcome.merged) {
          return { status: `Merged ${String(outcome.opsMerged ?? 0)} recorded fact(s) into the profile.` }
        }
        switch (outcome.reason) {
          case 'busy':
            return { status: 'Another session is merging right now; your facts are recorded and will be folded in shortly.' }
          case 'idle':
            return { status: 'Nothing recorded to merge yet.' }
          case 'no-baseline':
            return { status: 'Refused to merge: the profile has no recorded history behind it.' }
          case 'no-model':
            return { status: 'Could not merge: no provider/model is available for this session yet.' }
          case 'rejected-unevidenced-removal':
            return { status: 'Refused to merge: the result would have dropped entries for no recorded reason. The profile is unchanged.' }
          case 'completion-failed':
            return { status: 'Could not merge right now; your facts are recorded and will be folded in later.' }
          default:
            return { status: 'Nothing to merge yet.' }
        }
      },
    }))

    // Session end is the natural finishing point: fold in whatever this
    // session recorded, even below the weight threshold, so a short session's
    // facts do not sit pending indefinitely (spec §5.5). Fire-and-forget.
    ctx.on('session/disposed', () => {
      if (lastAgent === undefined) return
      scheduleMerge(ctx, lastAgent, workspaceRoot, triggerOptions)
    })
  }

  // Turn counter is process-local and per-agent: it need only survive one
  // running instance to nudge a long session, not across restarts.
  const turnsSinceReminder = new WeakMap<Agent, number>()
  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    rememberAgent({ agent })
    // Refresh before the model runs so any `wiki_note` call this step is
    // checked against what this session could actually have seen this turn,
    // not stale state from whenever the plugin loaded or last wrote. Only the
    // v1 path consults it; the v2 path writes ops and never checks baselines.
    if (!v2) refreshLastSeen()
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const count = (turnsSinceReminder.get(agent) ?? 0) + 1
    if (count < everyTurns) {
      turnsSinceReminder.set(agent, count)
      return decision
    }
    turnsSinceReminder.set(agent, 0)
    return { ...decision, messages: [...decision.messages, renderReminder()] }
  })
}

/**
 * Writer identity for an op: the session that produced it, or a marker when
 * no session is known. `by` is what lets the op stream be audited back to who
 * recorded a fact, so it must never be a bare guess.
 * @param agent - the session's agent, when one is available.
 */
function sessionOf(agent: Agent | undefined): string {
  return agent === undefined ? 'unknown-session' : String(agent.session.id)
}
