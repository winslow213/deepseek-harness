/**
 * Knowledge-base tools for a dsh session, against the team KB server (a
 * separate Rust service — see `/home/winslow/Desktop/wiki-server` on the deploy
 * host). Three tools, split by cost:
 *
 *   * `kb_search` — retrieval only, about one second. Reads the server's
 *     unauthenticated read surface (`/api/kb/search` + `/api/kb/document`) and
 *     returns the original passages, deduped per page and sliced to the
 *     matching section.
 *   * `kb_answer` — synthesis, 30-130s. Opens a session and runs a query job.
 *   * `kb_document` — read one page in full.
 *
 * Splitting them is deliberate: a single tool that both retrieves and
 * synthesizes forces the caller to pay for synthesis before it has seen any
 * evidence, and the model is the only party that can judge whether evidence is
 * enough. This file has no build of its own: it is copied verbatim into
 * `<home>/plugins/kb/` by `writeTeamKbSearchPatch` in `../spawn-user.ts` and
 * loaded by cordis from that copy at runtime, the same way
 * `../remote/wiki-tool.ts` is.
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
  /**
   * Agent token the KB server accepts as a read-only service credential. The
   * KB server gates writes behind a caller, but opening a session and asking a
   * question are a reader's handshake, so it accepts a service token for those
   * two calls. Without a token those calls answer 401 and search is unusable.
   */
  agentToken?: string
  /** Abort the whole query (session + job + result wait) after this many ms (default 180000). */
  timeoutMs?: number
}

/** Schemastery configuration for the kb-search tool consumer. */
export const Config: z<Config> = z.object({
  kbBaseUrl: z.string().required(),
  userId: z.string().required(),
  scope: z.string().default('wiki'),
  // Optional so a deployment that has not injected a token still loads; search
  // then fails with the server's 401 rather than a config error.
  agentToken: z.string(),
  // The KB server's LLM-backed synthesis step alone regularly runs 60-90s on
  // real queries against the production KB (observed: 64s, 63s for ordinary
  // questions); 60000 cut those off just short of completion, so the budget
  // needs enough headroom over that observed range rather than matching it.
  timeoutMs: z.number().step(1).min(1000).default(180000),
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

/** Bearer header for the KB server, or nothing when no token was injected. */
function authHeaders(agentToken: string | undefined): Record<string, string> {
  return agentToken === undefined || agentToken.trim() === ''
    ? {}
    : { authorization: `Bearer ${agentToken.trim()}` }
}

async function createSession(kbBaseUrl: string, userId: string, scope: string, agentToken: string | undefined, signal: AbortSignal): Promise<string> {
  const response = await fetch(`${kbBaseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(agentToken) },
    body: JSON.stringify({ user_id: userId, client: 'dsh', requested_scopes: [scope] }),
    signal,
  })
  if (!response.ok) {
    throw new Error(`kb: could not open a KB session (HTTP ${response.status}): ${await response.text()}`)
  }
  const body = await response.json() as { session_id: string }
  return body.session_id
}

/**
 * The cached KB session no longer exists server-side (its 24h TTL lapsed while
 * the dsh process sat idle). Signalled separately from other failures so
 * `execute` can rebuild the session and retry once, instead of failing every
 * later call for the remaining lifetime of the process.
 */
class SessionExpiredError extends Error {
  constructor(sessionId: string) {
    super(`kb: KB session expired: ${sessionId}`)
    this.name = 'SessionExpiredError'
  }
}

async function createQueryJob(
  kbBaseUrl: string,
  sessionId: string,
  scope: string,
  query: string,
  categoryIds: string[] | undefined,
  topK: number | undefined,
  agentToken: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(`${kbBaseUrl}/api/jobs/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(agentToken) },
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
    const detail = await response.text()
    if (response.status === 404 && detail.includes('session does not exist')) {
      throw new SessionExpiredError(sessionId)
    }
    throw new Error(`kb: could not create a query job (HTTP ${response.status}): ${detail}`)
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
    throw new Error(`kb: could not read job events (HTTP ${response.status}): ${await response.text()}`)
  }
  const events = parseSseEvents(await response.text())
  const terminal = [...events].reverse().find((event) => TERMINAL_STATES.has(event.state))
  if (!terminal) throw new Error('kb: job event stream closed before reaching a terminal state')
  if (terminal.state !== 'completed') {
    const data = terminal.data as { error_message?: string } | undefined
    const reason = data?.error_message ?? terminal.message ?? `job ${terminal.state}`
    throw new Error(`kb: ${reason}`)
  }
  return terminal.data as { answer: string, citations: string[], used_docs: string[] }
}

/**
 * Land one search hit's section, sliced out of the page's markdown.
 *
 * The retrieval index chunks a page by heading trail and, for a long section,
 * into overlapping 800-char windows that all share that trail. The search
 * response therefore cannot hand back the passage: the same section appears as
 * several hits with the same heading. Re-slicing the page source here recovers
 * the whole section rather than 800 chars of it.
 */
function sliceSection(
  markdown: string,
  trail: string[],
  maxChars: number,
): { excerpt: string, sectionChars: number } {
  const lines = markdown.split('\n')
  if (trail.length === 0) {
    const body = markdown.trim().slice(0, maxChars)
    return { excerpt: body, sectionChars: markdown.trim().length }
  }
  // Heading levels come from the trail's position, matching the indexer: the
  // chunker drops every trailing entry at or below the level it just saw.
  const current: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+(.*)$/.exec(lines[i].trim())
    if (match === null) continue
    const level = match[1].length
    current.length = level - 1
    while (current.length < level - 1) current.push('')
    current[level - 1] = match[2].trim()
    if (current.length !== trail.length || current.some((part, at) => part !== trail[at])) continue
    let end = lines.length
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = /^(#{1,6})\s/.exec(lines[j].trim())
      if (next !== null && next[1].length <= level) {
        end = j
        break
      }
    }
    const section = lines.slice(i, end).join('\n').trim()
    return { excerpt: section.slice(0, maxChars), sectionChars: section.length }
  }
  // The heading moved or was renamed since the index was built. The page still
  // matched, so hand back its opening rather than nothing.
  const body = markdown.trim().slice(0, maxChars)
  return { excerpt: body, sectionChars: markdown.trim().length }
}

/** Classify a page from the directory its path names, so the model can weigh an upstream document against a written summary. */
function classifyKind(path: string): string {
  if (path.startsWith('raw/')) return 'raw'
  if (path.startsWith('wiki/outputs/') || path.startsWith('outputs/')) return 'solution'
  return 'curated'
}

interface KbSearchHit {
  path: string
  score: number
  semantic?: number
  heading?: string
  title?: string
}

interface KbSearchBody {
  query: string
  scope: string
  top_k: number
  hits: KbSearchHit[]
}

interface KbDocumentBody {
  scope: string
  path: string
  title: string
  markdown: string
}

/** Unauthenticated GET against the KB read surface. */
async function kbGet<T>(url: string, signal: AbortSignal, what: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal })
  if (!response.ok) {
    throw new Error(`kb: ${what} failed (HTTP ${response.status}): ${await response.text()}`)
  }
  return await response.json() as T
}

const DEFAULT_MAX_CHARS = 4000
const MAX_MAX_CHARS = 20000
/** Pages wanted by default, and the ceiling, counted after dedup. */
const DEFAULT_PAGES = 5
const MAX_PAGES = 8
/**
 * How many raw hits to ask the server for per page wanted.
 *
 * One page contributes several hits — a long section is windowed, and separate
 * sections of the same file both match — so requesting `topK` hits would return
 * barely `topK / 2` distinct pages. Measured over 10 real queries, 5 distinct
 * pages needed a median of 7 and up to 15 raw hits.
 */
const HITS_PER_PAGE = 4
const MIN_RAW_HITS = 20
/** `MAX_TOP_K` in the KB server's handler. */
const SERVER_MAX_TOP_K = 50
/**
 * Relevance floor on the raw cosine.
 *
 * Not on `score`: that is reciprocal-rank fusion, which over 132k chunks
 * compresses every query — on-topic or not — into 0.016-0.033. Measured,
 * "推荐一部电影" scores 0.0315, above 6 of 10 real questions. Cosine separates
 * (0.62-0.82 in domain, 0.40-0.74 out of it); at 0.60 one of eight off-topic
 * queries still passed and none of thirteen real ones were lost.
 */
const MIN_COSINE = 0.6

const SEARCH_DESCRIPTION = [
  "Search the team's knowledge base and return the original passages it contains,",
  'not a synthesized answer. Use this first for almost every question: it answers in about',
  'one second, while `kb_answer` spends 30-130s running two LLM passes. Each hit is one',
  'page with its relevant section already extracted, plus `cosine` (how on-topic the page',
  'is, 0-1) and `truncated`/`sectionChars` (whether you are seeing the whole section —',
  'raise `maxChars` or call `kb_document` when it is cut). `covered: false` means nothing',
  'in the KB matched this question; that is a fact about the query, not proof the KB is',
  'silent on the topic, so rephrase or try `kb_answer` before concluding anything.',
  'If the excerpts genuinely do not answer the question, escalate to `kb_answer`.',
].join(' ')

const ANSWER_DESCRIPTION = [
  "Answer a question by synthesizing the team's knowledge base into a cited response.",
  'This runs two LLM passes plus verification and typically takes 30-130 seconds, so prefer',
  '`kb_search` first and only escalate when the raw passages are insufficient, or when the',
  'answer must be publishable and therefore needs the verification pass. Returns an error',
  "rather than inventing content the KB does not contain — never treat that error as",
  'evidence the topic is absent.',
].join(' ')

const DOCUMENT_DESCRIPTION = [
  'Read one knowledge-base page in full. Use it after `kb_search` when a hit was',
  '`truncated` and you need the rest of the section or page. Takes a scope-relative path',
  'exactly as `kb_search` returned it.',
].join(' ')

/**
 * Register `kb_search`, `kb_answer`, and `kb_document` on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the KB server URL, account id, scope, and timeout.
 */
export function apply(ctx: Context, config: Config): void {
  const kbBaseUrl = config.kbBaseUrl.replace(/\/+$/, '')
  const scope = config.scope ?? 'wiki'
  const timeoutMs = config.timeoutMs ?? 60000
  // The read surface answers in about a second; a retrieval call that hangs
  // should fail fast rather than hold the turn for the synthesis budget.
  const retrievalTimeoutMs = Math.min(timeoutMs, 20000)

  // Sessions are cheap to create and carry a 24h server-side TTL, caching one
  // per plugin instance avoids a round trip on every call. A process can
  // outlive that TTL, so `answer` rebuilds it on the server's "session does not
  // exist" reply rather than trusting the cached value.
  //
  // The cache holds a promise, not the resolved id: two concurrent calls both
  // saw `undefined` and each opened its own session, which the server counts
  // against the caller's session quota.
  let sessionPromise: Promise<string> | undefined
  const cachedSession = (signal: AbortSignal): Promise<string> => {
    if (sessionPromise === undefined) {
      sessionPromise = createSession(kbBaseUrl, config.userId, scope, config.agentToken, signal)
      // A failed handshake must not poison the cache for later calls.
      sessionPromise.catch(() => { sessionPromise = undefined })
    }
    return sessionPromise
  }

  ctx.tools.register(defineTool({
    name: 'kb_search',
    description: SEARCH_DESCRIPTION,
    // The fast path is a set of independent GETs with no shared session or job,
    // so parallel calls are safe and should not be serialized behind each other.
    isConcurrencySafe: () => true,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'What to look for. One query covering several sub-questions beats several narrow calls.',
      },
      topK: {
        type: 'integer',
        description: `Distinct pages to return (default ${DEFAULT_PAGES}, max ${MAX_PAGES}).`,
      },
      maxChars: {
        type: 'integer',
        description: `Characters of each page's section to return (default ${DEFAULT_MAX_CHARS}, max ${MAX_MAX_CHARS}).`,
      },
      minCosine: {
        type: 'number',
        description: `Relevance floor, 0-1 (default ${MIN_COSINE}). Lower it to see weak matches instead of nothing.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          covered: { type: 'boolean', required: true },
          bestCosine: { type: 'number', required: true },
          threshold: { type: 'number', required: true },
          note: { type: 'string', required: true },
          timings: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              searchMs: { type: 'number', required: true },
              fetchMs: { type: 'number', required: true },
              totalMs: { type: 'number', required: true },
            },
          },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                title: { type: 'string', required: true },
                heading: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                score: { type: 'number', required: true },
                cosine: { type: 'number', required: true },
                excerpt: { type: 'string', required: true },
                excerptChars: { type: 'integer', required: true },
                sectionChars: { type: 'integer', required: true },
                truncated: { type: 'boolean', required: true },
                moreHeadings: { type: 'array', items: { type: 'string' }, required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSearch(value) }],
    },
    async execute(args, exec) {
      const started = Date.now()
      const controller = new AbortController()
      const onCallerAbort = (): void => {
        const reason = exec.signal.reason
        controller.abort(reason instanceof Error ? reason : new Error(`kb_search: cancelled (${JSON.stringify(reason)})`))
      }
      exec.signal.addEventListener('abort', onCallerAbort)
      const timer = setTimeout(
        () => controller.abort(new Error('kb_search: timed out waiting on the KB server')),
        retrievalTimeoutMs,
      )
      try {
        const pages = Math.min(Math.max(args.topK ?? DEFAULT_PAGES, 1), MAX_PAGES)
        const maxChars = Math.min(Math.max(args.maxChars ?? DEFAULT_MAX_CHARS, 500), MAX_MAX_CHARS)
        const threshold = args.minCosine ?? MIN_COSINE
        const raw = Math.min(Math.max(pages * HITS_PER_PAGE, MIN_RAW_HITS), SERVER_MAX_TOP_K)

        const searchStarted = Date.now()
        const body = await kbGet<KbSearchBody>(
          `${kbBaseUrl}/api/kb/search?scope=${encodeURIComponent(scope)}&top_k=${raw}&q=${encodeURIComponent(args.query)}`,
          controller.signal,
          'retrieval search',
        )
        const searchMs = Date.now() - searchStarted

        const bestCosine = body.hits.reduce((best, hit) => Math.max(best, hit.semantic ?? 0), 0)
        const timings = { searchMs, fetchMs: 0, totalMs: 0 }
        // Drop the passages below the floor rather than only checking the best
        // one: a page that matched on a generic word must not ride in on the
        // strength of a genuinely good hit beside it.
        const relevant = body.hits.filter((hit) => (hit.semantic ?? 0) >= threshold)
        if (relevant.length === 0) {
          return {
            covered: false,
            bestCosine,
            threshold,
            hits: [],
            timings: { ...timings, totalMs: Date.now() - started },
            note: body.hits.length === 0
              ? 'The retrieval index returned no passages for this query.'
              : `Best match scored ${bestCosine.toFixed(3)} cosine, below the ${threshold} floor — nothing in the KB looks on-topic. This says the query did not match, not that the KB is silent: rephrase, lower minCosine, or try kb_answer.`,
          }
        }

        // One page contributes several hits (windowed sections, and separate
        // sections of one file), so dedup by section and keep the best of each.
        const seen = new Set<string>()
        const chosen: KbSearchHit[] = []
        const headingsByPath = new Map<string, string[]>()
        for (const hit of relevant) {
          const heading = hit.heading ?? ''
          const list = headingsByPath.get(hit.path) ?? []
          if (heading !== '' && !list.includes(heading)) list.push(heading)
          headingsByPath.set(hit.path, list)
          const key = `${hit.path}\u0000${heading}`
          if (seen.has(key)) continue
          seen.add(key)
          chosen.push(hit)
        }
        // Stable pick: highest score first, then one heading per page until the
        // page budget runs out, so `topK` counts pages rather than sections.
        const picked: KbSearchHit[] = []
        const perPath = new Map<string, number>()
        for (const hit of [...chosen].sort((a, b) => b.score - a.score)) {
          if (picked.length >= pages) break
          const used = perPath.get(hit.path) ?? 0
          if (used >= 1) continue
          perPath.set(hit.path, used + 1)
          picked.push(hit)
        }

        const fetchStarted = Date.now()
        const documents = new Map<string, KbDocumentBody>()
        await Promise.all(picked.map(async (hit) => {
          const page = await kbGet<KbDocumentBody>(
            `${kbBaseUrl}/api/kb/document?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(hit.path)}`,
            controller.signal,
            `reading ${hit.path}`,
          )
          documents.set(hit.path, page)
        }))
        const fetchMs = Date.now() - fetchStarted

        const hits = picked.map((hit) => {
          const page = documents.get(hit.path)
          const trail = (hit.heading ?? '') === '' ? [] : (hit.heading ?? '').split(' > ')
          const sliced = sliceSection(page?.markdown ?? '', trail, maxChars)
          const others = (headingsByPath.get(hit.path) ?? []).filter((h) => h !== (hit.heading ?? ''))
          return {
            path: hit.path,
            title: page?.title ?? hit.title ?? hit.path,
            heading: hit.heading ?? '',
            kind: classifyKind(hit.path),
            score: hit.score,
            cosine: hit.semantic ?? 0,
            excerpt: sliced.excerpt,
            excerptChars: sliced.excerpt.length,
            sectionChars: sliced.sectionChars,
            truncated: sliced.sectionChars > sliced.excerpt.length,
            moreHeadings: others,
          }
        })

        return {
          covered: true,
          bestCosine,
          threshold,
          hits,
          timings: { searchMs, fetchMs, totalMs: Date.now() - started },
          note: 'Original passages, not a synthesis. Escalate to kb_answer if these do not answer the question.',
        }
      } finally {
        clearTimeout(timer)
        exec.signal.removeEventListener('abort', onCallerAbort)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kb_document',
    description: DOCUMENT_DESCRIPTION,
    isConcurrencySafe: () => true,
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Scope-relative page path, exactly as kb_search returned it.',
      },
      heading: {
        type: 'string',
        description: 'Optional heading trail ("A > B") to return only that section.',
      },
      maxChars: {
        type: 'integer',
        description: `Characters to return (default ${MAX_MAX_CHARS}).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          title: { type: 'string', required: true },
          content: { type: 'string', required: true },
          contentChars: { type: 'integer', required: true },
          totalChars: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.truncated
          ? `${value.content}\n\n[${value.path}: showing ${value.contentChars} of ${value.totalChars} characters]`
          : `${value.content}\n\n[${value.path}]`,
      }],
    },
    async execute(args, exec) {
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(new Error('kb_document: timed out waiting on the KB server')),
        retrievalTimeoutMs,
      )
      try {
        const page = await kbGet<KbDocumentBody>(
          `${kbBaseUrl}/api/kb/document?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(args.path)}`,
          controller.signal,
          'document read',
        )
        const maxChars = Math.min(Math.max(args.maxChars ?? MAX_MAX_CHARS, 500), MAX_MAX_CHARS)
        const trail = args.heading === undefined || args.heading === '' ? [] : args.heading.split(' > ')
        const sliced = sliceSection(page.markdown, trail, maxChars)
        return {
          path: page.path,
          title: page.title,
          content: sliced.excerpt,
          contentChars: sliced.excerpt.length,
          totalChars: trail.length === 0 ? page.markdown.trim().length : sliced.sectionChars,
          truncated: sliced.sectionChars > sliced.excerpt.length,
        }
      } finally {
        clearTimeout(timer)
        void exec
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kb_answer',
    description: ANSWER_DESCRIPTION,
    // The server owns query concurrency, so overlapping calls queue there
    // rather than needing to be serialized here.
    isConcurrencySafe: () => true,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'The question to answer from the knowledge base.',
      },
      topK: {
        type: 'integer',
        description: 'Supporting documents to retrieve (default 6).',
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
      // The upstream signal's abort reason can be a non-Error value (e.g. the
      // agent loop's `{ kind: 'aborted', reason: { kind: 'user' } }` on a
      // user-cancelled turn); propagating it verbatim reaches the tool
      // framework's generic `String(error)` fallback and renders as the
      // unreadable "Error: [object Object]". Always forward a real Error with
      // a readable cause instead.
      const onCallerAbort = (): void => {
        const reason = exec.signal.reason
        controller.abort(reason instanceof Error ? reason : new Error(`kb_answer: cancelled (${JSON.stringify(reason)})`))
      }
      exec.signal.addEventListener('abort', onCallerAbort)
      const timer = setTimeout(() => controller.abort(new Error('kb_answer: timed out waiting on the KB server')), timeoutMs)
      try {
        const runQuery = async (sessionId: string): Promise<{ answer: string, citations: string[], used_docs: string[] }> => {
          const jobId = await createQueryJob(kbBaseUrl, sessionId, scope, args.query, undefined, args.topK, config.agentToken, controller.signal)
          return awaitJobResult(kbBaseUrl, jobId, controller.signal)
        }
        let result: { answer: string, citations: string[], used_docs: string[] }
        try {
          result = await runQuery(await cachedSession(controller.signal))
        } catch (error) {
          if (!(error instanceof SessionExpiredError)) throw error
          // The cached id lapsed (server-side TTL) while this process was idle
          // and will never come back, so rebuild once and retry.
          sessionPromise = undefined
          result = await runQuery(await cachedSession(controller.signal))
        }
        // Defensive coercion, not paranoia: this tool's output schema requires
        // these keys, and the framework rejects the *whole* result with "value is
        // not lossless JSON" when one is `undefined`. A model that answered in
        // Chinese once produced `{使用文档, 引用文档, 答案}`, so a 138-second run
        // ended in that error with a perfectly good answer behind it. The runner
        // now normalizes the keys, but a stale job or a future drift should
        // degrade to an empty list rather than lose the answer.
        return {
          answer: result.answer ?? '',
          citations: Array.isArray(result.citations) ? result.citations : [],
          usedDocs: Array.isArray(result.used_docs) ? result.used_docs : [],
        }
      } finally {
        clearTimeout(timer)
        exec.signal.removeEventListener('abort', onCallerAbort)
      }
    },
  }))
}

/** Format one retrieval result as the text the model reads. */
function renderSearch(value: {
  covered: boolean
  bestCosine: number
  threshold: number
  note: string
  hits: Array<{
    path: string
    title: string
    heading: string
    kind: string
    score: number
    cosine: number
    excerpt: string
    excerptChars: number
    sectionChars: number
    truncated: boolean
    moreHeadings: string[]
  }>
}): string {
  if (!value.covered) {
    return `No confident match (best cosine ${value.bestCosine.toFixed(3)} < ${value.threshold}).\n${value.note}`
  }
  const blocks = value.hits.map((hit, index) => {
    const where = hit.heading === '' ? hit.title : `${hit.title} — ${hit.heading}`
    const cut = hit.truncated
      ? `\n[... truncated: ${hit.excerptChars} of ${hit.sectionChars} characters; raise maxChars or use kb_document]`
      : ''
    const more = hit.moreHeadings.length > 0
      ? `\nOther matching sections in this page: ${hit.moreHeadings.join(' | ')}`
      : ''
    return `--- ${index + 1}. ${where}\n${hit.path}  [${hit.kind}, cosine ${hit.cosine.toFixed(3)}]\n\n${hit.excerpt}${cut}${more}`
  })
  return `${blocks.join('\n\n')}\n\n${value.note}`
}
