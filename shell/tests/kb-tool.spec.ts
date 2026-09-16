import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as tool from '../src/remote/kb-tool.ts'

const testToolSignal = new AbortController().signal

function sessionAgent(id = 'kb-agent'): Agent {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, cwd: '/', isSeeded: false,
  })
  return {
    id: sessionId,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('unused in this test') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

let callCounter = 0
function callKbSearch(ctx: Context, args: unknown, agent: Agent) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name: 'kb_search',
    arguments: args,
    agent,
  })
}

/** A fake KB server implementing just enough of the job API for the tool. */
class FakeKbServer {
  server: Server
  baseUrl = ''
  sessionRequests = 0
  jobState: 'completed' | 'failed' = 'completed'

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
        this.handle(req.url ?? '', req.method ?? 'GET', body, res)
      })
    })
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('unexpected server address')
    this.baseUrl = `http://127.0.0.1:${address.port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((err) => err ? reject(err) : resolve()))
  }

  private handle(url: string, method: string, body: unknown, res: import('node:http').ServerResponse): void {
    if (method === 'POST' && url === '/api/sessions') {
      this.sessionRequests += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ session_id: 'sess-fake-1' }))
      return
    }
    if (method === 'POST' && url === '/api/jobs/query') {
      const { query } = body as { query: string }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ job_id: `job-${encodeURIComponent(query)}`, state: 'queued' }))
      return
    }
    if (method === 'GET' && /^\/api\/jobs\/.+\/events$/.test(url)) {
      // A job whose id encodes the never-completing query: hold the response
      // open (no `res.end()`) so a caller-side abort test has something live
      // to cancel instead of racing a response that already arrived.
      if (url.includes(encodeURIComponent('never completes'))) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const data = this.jobState === 'completed'
        ? { answer: 'A-law and u-law differ in companding curve.', citations: ['g711.md'], used_docs: ['g711'] }
        : { error_code: 'no_docs', error_message: 'no relevant documents found' }
      const event = {
        event_id: 'evt-1', job_id: 'job-1', state: this.jobState, message: null, data, ts: '2026-09-16T00:00:00Z',
      }
      res.end(`event: job.${this.jobState}\ndata: ${JSON.stringify(event)}\n\n`)
      return
    }
    res.writeHead(404)
    res.end('not found')
  }
}

describe('kb_search tool', () => {
  let fake: FakeKbServer

  before(async () => {
    fake = new FakeKbServer()
    await fake.start()
  })

  after(async () => {
    await fake.stop()
  })

  async function setup(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(tool, { userId: 'alice', kbBaseUrl: fake.baseUrl })
    return ctx
  }

  it('registers a kb_search tool with a required query parameter', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'kb_search')
    assert.ok(schema)
    const props = (schema!.parameters as { properties?: Record<string, { required?: boolean }> }).properties
    assert.ok(props?.query)
  })

  it('returns a synthesized answer with citations on success', async () => {
    fake.jobState = 'completed'
    const ctx = await setup()
    const result = await callKbSearch(ctx, { query: 'a-law vs u-law' }, sessionAgent())
    assert.equal(result.isError, false)
    const text = JSON.stringify(result.content)
    assert.match(text, /companding curve/)
    assert.match(text, /g711\.md/)
  })

  it('caches the KB session across repeated calls instead of creating a new one each time', async () => {
    fake.jobState = 'completed'
    fake.sessionRequests = 0
    const ctx = await setup()
    await callKbSearch(ctx, { query: 'first' }, sessionAgent())
    await callKbSearch(ctx, { query: 'second' }, sessionAgent())
    assert.equal(fake.sessionRequests, 1)
  })

  it('surfaces a job failure as a tool-call error carrying the KB error message', async () => {
    fake.jobState = 'failed'
    const ctx = await setup()
    const result = await callKbSearch(ctx, { query: 'unanswerable' }, sessionAgent())
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result.content), /no relevant documents found/)
  })

  it('wraps a non-Error upstream abort reason (e.g. a user-cancelled turn) in a readable message', async () => {
    fake.jobState = 'completed'
    const ctx = await setup()
    const controller = new AbortController()
    const pending = ctx.tools.execute({
      signal: controller.signal,
      callId: ToolCallId(`call-${++callCounter}`),
      name: 'kb_search',
      arguments: { query: 'never completes' },
      agent: sessionAgent(),
    })
    // The real agent loop aborts a cancelled turn with a plain object reason
    // (`{ kind: 'aborted', reason: { kind: 'user' } }`), not an Error — the
    // tool must not let that reach the model as "Error: [object Object]".
    // Give the in-flight session/job-creation calls a moment to land before
    // aborting, so the cancellation lands mid-request (matching the observed
    // production failure) instead of the framework's own pre-dispatch check.
    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort({ kind: 'aborted', reason: { kind: 'user' } })
    const result = await pending
    assert.equal(result.isError, true)
    const text = JSON.stringify(result.content)
    assert.doesNotMatch(text, /\[object Object\]/)
    assert.match(text, /cancelled/)
  })
})
