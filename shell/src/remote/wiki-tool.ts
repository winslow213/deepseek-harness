/**
 * `wiki_note` tool: the model-facing write path for a user's four-layer
 * personal wiki (identity/preferences/timeline/decisions), plus a periodic
 * `<system-reminder>` nudge so a long session does not forget the tool
 * exists. This file has no build of its own: it is copied verbatim (with its
 * `wiki-fs.ts` sibling) into `<profileDir>/plugins/wiki/` by
 * `writeTeamUserWikiPatch` in `../spawn-user.ts` and loaded by cordis from
 * that copy at runtime, the same way `../remote/region-router.ts` is.
 *
 * @module dsh-team-shell/wiki-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scaffoldUserWiki, readWikiLayer, writeWikiLayer, WikiWriteConflictError, type WikiLayer, type WholeReplaceWikiLayer } from './wiki-fs.ts'

export const name = 'tool-wiki'
export const inject = ['agents', 'tools']

/** Model-facing `wiki_note` tool configuration. */
export interface Config {
  /** The account's private workspace root the four wiki files live under. */
  workspaceRoot: string
  /** Re-inject the reminder every this many `agent/pre-step` calls (default 6). */
  reminderEveryTurns?: number
}

/** Schemastery configuration for the wiki-note tool consumer. */
export const Config: z<Config> = z.object({
  workspaceRoot: z.string().required(),
  reminderEveryTurns: z.number().step(1).min(1).default(6),
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
  scaffoldUserWiki(workspaceRoot)

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
    description: DESCRIPTION,
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

  // Turn counter is process-local and per-agent: it need only survive one
  // running instance to nudge a long session, not across restarts.
  const turnsSinceReminder = new WeakMap<Agent, number>()
  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    // Refresh before the model runs so any `wiki_note` call this step is
    // checked against what this session could actually have seen this turn,
    // not stale state from whenever the plugin loaded or last wrote.
    refreshLastSeen()
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
