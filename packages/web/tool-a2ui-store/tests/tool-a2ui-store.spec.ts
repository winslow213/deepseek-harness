/** Behavior of the A2UI tool store: save/list/remove over a real temp directory. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { A2uiFormPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import * as tool from '../src/index.ts'
import { listA2uiTools, removeA2uiTool, saveA2uiTool } from '../src/store.ts'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-a2ui-store-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const page: A2uiFormPage = {
  kind: 'form',
  title: 'Deploy service',
  fields: [
    { name: 'env', label: 'Environment', type: 'select', options: [{ label: 'Prod', value: 'prod' }] },
    { name: 'confirm', label: 'Confirm', type: 'checkbox', required: true },
    { name: 'banner', label: 'Banner', type: 'text', compute: 'env.toUpperCase()' },
  ],
  actions: [{ id: 'deploy', label: 'Deploy', tool: 'run_deploy', instruction: 'Deploy now' }],
}

/** A context carrying the tool store and the model-tool registry. */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool, { dir })
  return ctx
}

describe('a2ui store', () => {
  it('saves and lists a tool with its page and logic intact', async () => {
    const record = await saveA2uiTool(dir, 'deploy-service', page)
    expect(record.name).toBe('deploy-service')
    expect(record.page).toEqual(page)
    expect(typeof record.savedAt).toBe('string')

    const listed = await listA2uiTools(dir)
    expect(listed.map(r => r.name)).toEqual(['deploy-service'])
    expect(listed[0]!.page).toEqual(page)
  })

  it('replaces a same-named tool and removes on demand', async () => {
    const updated: A2uiFormPage = { ...page, title: 'Deploy service v2' }
    await saveA2uiTool(dir, 'deploy-service', updated)
    expect((await listA2uiTools(dir))[0]!.page.title).toBe('Deploy service v2')

    expect(await removeA2uiTool(dir, 'deploy-service')).toBe(true)
    expect(await listA2uiTools(dir)).toEqual([])
    expect(await removeA2uiTool(dir, 'deploy-service')).toBe(false)
  })

  it('skips non-JSON and malformed files in the directory', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'README.txt'), 'not a tool')
    await writeFile(join(dir, 'broken.json'), '{ not json')
    await saveA2uiTool(dir, 'ok', page)
    expect((await listA2uiTools(dir)).map(r => r.name)).toEqual(['ok'])
    await rm(join(dir, 'README.txt'), { force: true })
    await rm(join(dir, 'broken.json'), { force: true })
    await removeA2uiTool(dir, 'ok')
  })

  it('rejects an unsafe tool name', async () => {
    await expect(saveA2uiTool(dir, '../escape', page)).rejects.toThrow('invalid a2ui tool name')
    await expect(saveA2uiTool(dir, 'a/b', page)).rejects.toThrow('invalid a2ui tool name')
  })
})

describe('a2ui_export tool', () => {
  function agentWithSession(id = 'parent-1'): Agent & { session: Session } {
    const session = Session.create(SessionId(id))
    return { id: SessionId(id), session } as unknown as Agent & { session: Session }
  }

  it('exports a page the model authored into the store', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('call-1'),
      name: 'a2ui_export',
      arguments: { name: 'from-tool', page },
      agent,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a2ui_export success')
    expect(result.value).toMatchObject({ name: 'from-tool', saved: true })

    const listed = await listA2uiTools(dir)
    expect(listed.map(r => r.name)).toContain('from-tool')
    await removeA2uiTool(dir, 'from-tool')
  })

  it('rejects a page the store cannot canonicalize', async () => {
    const ctx = await setup()
    const agent = agentWithSession()
    const bad = { kind: 'form', title: 'x', fields: [{ name: 'a', label: 'A', type: 'bogus' }] }
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('call-2'),
      name: 'a2ui_export',
      arguments: { name: 'bad', page: bad },
      agent,
    })
    expect(result.isError).toBe(true)
  })
})

describe('a2ui_attach_output tool', () => {
  const agent = { id: SessionId('parent-1'), session: Session.create(SessionId('parent-1')) } as unknown as Agent & { session: Session }

  it('attaches a job to a surface and reports it', async () => {
    const ctx = await setup()
    const attach = vi.spyOn(ctx.a2uiLive, 'attach').mockImplementation(() => {})
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('call-1'),
      name: 'a2ui_attach_output',
      arguments: { surfaceId: 'surf-1', jobId: 'job-1' },
      agent,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a2ui_attach_output success')
    expect(result.value).toEqual({ surfaceId: 'surf-1', jobId: 'job-1', attached: true })
    expect(attach).toHaveBeenCalledWith('surf-1', 'job-1', agent)
    expect(ctx.tools.get('a2ui_attach_output')?.presentCall?.({ surfaceId: 'surf-1', jobId: 'job-1' }))
      .toEqual({ card: 'generic', title: 'Stream job output into surf-1', kind: 'other', rawInput: { surfaceId: 'surf-1', jobId: 'job-1' } })
  })

  it('requires an owning agent', async () => {
    const ctx = await setup()
    const attach = vi.spyOn(ctx.a2uiLive, 'attach').mockImplementation(() => {})
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('call-2'),
      name: 'a2ui_attach_output',
      arguments: { surfaceId: 'surf-1', jobId: 'job-1' },
    } as never)
    expect(result.isError).toBe(true)
    expect(attach).not.toHaveBeenCalled()
  })
})
