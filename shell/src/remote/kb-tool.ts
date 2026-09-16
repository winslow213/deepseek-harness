/**
 * `kb_search` tool: lets a dsh session query the team's LLM-backed knowledge
 * base server (a separate Rust service — see `/home/winslow/Desktop/wiki-server`
 * on the deploy host) over its HTTP job API and return a synthesized,
 * citation-backed answer. This file has no build of its own: it is copied
 * verbatim into `<home>/plugins/kb/` by `writeTeamKbSearchPatch` in
 * `../spawn-user.ts` and loaded by cordis from that copy at runtime, the same
 * way `../remote/wiki-tool.ts` is.
 *
 * @module dsh-team-shell/kb-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-kb-search'
export const inject = ['tools']

/** Model-facing `kb_search` tool configuration. */
export interface Config {
  /** Base URL of the team KB agent server, e.g. `http://127.0.0.1:8080`. */
  kbBaseUrl: string
  /** The account id the KB session is created under. */
  userId: string
  /** KB catalog scope to search (default `wiki`). */
  scope?: string
  /** Abort the whole query (session + job + result wait) after this many ms (default 60000). */
  timeoutMs?: number
}

/** Schemastery configuration for the kb-search tool consumer. */
export const Config: z<Config> = z.object({
  kbBaseUrl: z.string().required(),
  userId: z.string().required(),
  scope: z.string().default('wiki'),
  timeoutMs: z.number().step(1).min(1000).default(60000),
})

/** One event off the KB server's job SSE stream (`GET /api/jobs/{id}/events`). */
interface KbJobEvent {
  event_id: string
  job_id: string
  state: string
  stage?: string
  message?: string
  data?: unknown
  ts: string
}

/** The KB server's terminal `JobState` values (see `src/domain/enums.rs`). */
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled'])

const DESCRIPTION = [
  "Search the team's knowledge base for durable, previously-recorded facts (architecture notes,",
  'runbooks, decisions, glossary entries) that this conversation did not otherwise provide.',
  'Returns a synthesized answer with citations into the KB, or an error if nothing relevant was',
  "found — the KB refuses to fabricate an answer beyond what its documents actually say. Prefer",
  'this over guessing when a question depends on team-specific or historical knowledge.',
].join(' ')

/**
 * Parse a `text/event-stream` body into its `data:` JSON payloads, in order.
 * Blank-line-separated blocks and keep-alive comments are the only framing
 * this tool needs to handle; multi-line `data:` fields are unused by the KB
 * server's event encoder and are joined defensively rather than assumed away.
 */
function parseSseEvents(raw: string): KbJobEvent[] {
  const events: KbJobEvent[] = []
  for (const block of raw.split('\n\n')) {
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
    if (dataLines.length === 0) continue
    try {
      events.push(JSON.parse(dataLines.join('\n')) as KbJobEvent)
    } catch {
      // Not a data-bearing event (e.g. a bare keep-alive comment) — skip it.
    }
  }
  return events
}

async function createSession(kbBaseUrl: string, userId: string, scope: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(`${kbBaseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: userId, client: 'dsh', requested_scopes: [scope] }),
    signal,
  })
  if (!response.ok) {
    throw new Error(`kb_search: could not open a KB session (HTTP ${response.status}): ${await response.text()}`)
  }
  const body = await response.json() as { session_id: string }
  return body.session_id
}

async function createQueryJob(
  kbBaseUrl: string,
  sessionId: string,
  scope: string,
  query: string,
  categoryIds: string[] | undefined,
  topK: number | undefined,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(`${kbBaseUrl}/api/jobs/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      scope,
      category_ids: categoryIds ?? [],
      query,
      // The KB server's runner script crashes on an explicit `top_k: null`
      // (which is what an omitted field round-trips to once the server
      // re-serializes the job payload) instead of falling back to its own
      // default, so always send a concrete value from this client.
      top_k: topK ?? 8,
      persist_answer: false,
    }),
    signal,
  })
  if (!response.ok) {
    throw new Error(`kb_search: could not create a query job (HTTP ${response.status}): ${await response.text()}`)
  }
  const body = await response.json() as { job_id: string }
  return body.job_id
}

/**
 * Block on the KB server's SSE stream for one job until it reaches a
 * terminal state, and return the parsed result. The stream endpoint itself
 * blocks server-side until the job completes/fails/cancels (or the caller's
 * signal aborts), so one request is enough — no client-side polling loop.
 */
async function awaitJobResult(
  kbBaseUrl: string,
  jobId: string,
  signal: AbortSignal,
): Promise<{ answer: string, citations: string[], used_docs: string[] }> {
  const response = await fetch(`${kbBaseUrl}/api/jobs/${jobId}/events`, {
    headers: { accept: 'text/event-stream' },
    signal,
  })
  if (!response.ok) {
    throw new Error(`kb_search: could not read job events (HTTP ${response.status}): ${await response.text()}`)
  }
  const events = parseSseEvents(await response.text())
  const terminal = [...events].reverse().find((event) => TERMINAL_STATES.has(event.state))
  if (!terminal) throw new Error('kb_search: job event stream closed before reaching a terminal state')
  if (terminal.state !== 'completed') {
    const data = terminal.data as { error_message?: string } | undefined
    const reason = data?.error_message ?? terminal.message ?? `job ${terminal.state}`
    throw new Error(`kb_search: ${reason}`)
  }
  return terminal.data as { answer: string, citations: string[], used_docs: string[] }
}

/**
 * Register `kb_search` on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the KB server URL, account id, scope, and timeout.
 */
export function apply(ctx: Context, config: Config): void {
  const kbBaseUrl = config.kbBaseUrl.replace(/\/+$/, '')
  const scope = config.scope ?? 'wiki'
  const timeoutMs = config.timeoutMs ?? 60000

  // Sessions are cheap to create and carry a 24h server-side TTL; caching one
  // per plugin instance (i.e. per dsh process lifetime) avoids a round trip
  // on every call without needing any expiry-refresh logic for a lifetime
  // this short relative to the TTL.
  let cachedSessionId: string | undefined

  ctx.tools.register(defineTool({
    name: 'kb_search',
    description: DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'The question to search the knowledge base for.',
      },
      categoryIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict the search to these KB category ids, if known. Omit to search the whole scope.',
      },
      topK: {
        type: 'integer',
        description: 'Maximum number of supporting documents to retrieve (server default applies if omitted).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string', required: true },
          citations: { type: 'array', items: { type: 'string' }, required: true },
          usedDocs: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.citations.length > 0 ? `${value.answer}\n\nSources: ${value.citations.join(', ')}` : value.answer,
      }],
    },
    async execute(args, exec) {
      const controller = new AbortController()
      const onCallerAbort = (): void => controller.abort(exec.signal.reason)
      exec.signal.addEventListener('abort', onCallerAbort)
      const timer = setTimeout(() => controller.abort(new Error('kb_search: timed out waiting on the KB server')), timeoutMs)
      try {
        cachedSessionId ??= await createSession(kbBaseUrl, config.userId, scope, controller.signal)
        const jobId = await createQueryJob(kbBaseUrl, cachedSessionId, scope, args.query, args.categoryIds, args.topK, controller.signal)
        const result = await awaitJobResult(kbBaseUrl, jobId, controller.signal)
        return { answer: result.answer, citations: result.citations, usedDocs: result.used_docs }
      } finally {
        clearTimeout(timer)
        exec.signal.removeEventListener('abort', onCallerAbort)
      }
    },
  }))
}
