import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as tool from '../src/remote/wiki-tool.ts'
import { wikiPaths } from '../src/remote/wiki-fs.ts'

const testToolSignal = new AbortController().signal

async function setup(workspaceRoot: string, reminderEveryTurns?: number): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(tool, { workspaceRoot, ...reminderEveryTurns !== undefined ? { reminderEveryTurns } : {} })
  return ctx
}

function sessionAgent(id = 'wiki-agent'): Agent {
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
function callWikiNote(ctx: Context, args: unknown, agent: Agent) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name: 'wiki_note',
    arguments: args,
    agent,
  })
}

describe('wiki_note tool', () => {
  it('registers a wiki_note tool with the four-layer kind enum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-tool-'))
    try {
      const ctx = await setup(root)
      const schema = ctx.tools.schemas().find(s => s.name === 'wiki_note')
      assert.ok(schema)
      const kindProp = (schema!.parameters as { properties?: Record<string, { enum?: string[] }> }).properties?.kind
      assert.deepEqual(kindProp?.enum, ['identity', 'preferences', 'timeline', 'decision'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('overwrites the identity file whole on each call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-tool-'))
    try {
      const ctx = await setup(root)
      const agent = sessionAgent()
      await callWikiNote(ctx, { kind: 'identity', content: 'first identity' }, agent)
      await callWikiNote(ctx, { kind: 'identity', content: 'second identity' }, agent)
      const content = await readFile(wikiPaths(root).identity, 'utf8')
      assert.equal(content, 'second identity\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('appends timeline entries and requires a title', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-tool-'))
    try {
      const ctx = await setup(root)
      const agent = sessionAgent()
      const missingTitle = await callWikiNote(ctx, { kind: 'timeline', content: 'no title given' }, agent)
      assert.equal(missingTitle.isError, true)
      await callWikiNote(ctx, { kind: 'timeline', title: 'milestone', content: 'reached it' }, agent)
      const content = await readFile(wikiPaths(root).timeline, 'utf8')
      assert.match(content, /milestone/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires alternativesConsidered for decision entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-tool-'))
    try {
      const ctx = await setup(root)
      const agent = sessionAgent()
      const missingAlternatives = await callWikiNote(
        ctx, { kind: 'decision', title: 'chose X', content: 'went with X' }, agent,
      )
      assert.equal(missingAlternatives.isError, true)
      await callWikiNote(ctx, {
        kind: 'decision', title: 'chose X', content: 'went with X', alternativesConsidered: 'Y was slower',
      }, agent)
      const content = await readFile(wikiPaths(root).decisions, 'utf8')
      assert.match(content, /chose X/)
      assert.match(content, /Y was slower/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('injects a system-reminder message every N pre-steps and resets the counter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-tool-'))
    try {
      const ctx = await setup(root, 2)
      const agent = sessionAgent()
      const signal = new AbortController().signal
      const step = async () => agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        { messages: [], turn: 1, step: 1, signal },
        () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
      )
      const first = await step()
      assert.equal(first.messages.length, 0)
      const second = await step()
      assert.equal(second.messages.length, 1)
      const third = await step()
      assert.equal(third.messages.length, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
