/** Behavior of the A2UI Remote controllers: store list/open/delete and run start/read/stop/runScript over stubbed capabilities. */

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import type { A2uiStore } from '../src/index.ts'
import type { A2uiRun, A2uiRunStart } from '../src/run.ts'
import type { A2uiRunScript } from '../src/script.ts'
import { A2uiRunController, A2uiStoreController } from '../src/remote.ts'

/** A minimal agent whose session records cwd and every append. */
function agentStub(cwd?: string): {
  agent: { session: { header: { cwd?: string }; append: ReturnType<typeof vi.fn> } }
  append: ReturnType<typeof vi.fn>
} {
  const append = vi.fn()
  const agent = {
    session: {
      header: { ...cwd === undefined ? {} : { cwd } },
      append,
    },
  }
  return { agent, append }
}

/** A fresh context whose `agents` registry answers the stub (or undefined). */
function freshContext(agent: unknown): Context {
  const ctx = new Context()
  ctx.provide('agents', { get: () => agent })
  return ctx
}

const PAGE = { kind: 'form', title: 'T', fields: [] } as never

describe('A2uiStoreController', () => {
  it('lists the saved tools', async () => {
    const ctx = freshContext(undefined)
    ctx.provide('a2uiStore', { dir: '/tmp', list: vi.fn(async () => [{ name: 'a', page: PAGE, savedAt: '2026-01-01T00:00:00Z' }]) } as unknown as A2uiStore)
    const controller = new A2uiStoreController(ctx)
    await expect(controller.list()).resolves.toEqual({ tools: [{ name: 'a', page: PAGE, savedAt: '2026-01-01T00:00:00Z' }] })
  })

  it('refuses to open into a session with no live agent', async () => {
    const ctx = freshContext(undefined)
    ctx.provide('a2uiStore', { dir: '/tmp', list: vi.fn(async () => []) } as unknown as A2uiStore)
    const controller = new A2uiStoreController(ctx)
    await expect(controller.open({ sessionId: SessionId('s1'), name: 'a' })).rejects.toMatchObject({
      code: 'a2ui-store/agent-offline',
    })
  })

  it('refuses to open a tool that is not saved', async () => {
    const { agent } = agentStub()
    const ctx = freshContext(agent)
    ctx.provide('a2uiStore', { dir: '/tmp', list: vi.fn(async () => []) } as unknown as A2uiStore)
    const controller = new A2uiStoreController(ctx)
    await expect(controller.open({ sessionId: SessionId('s1'), name: 'missing' })).rejects.toMatchObject({
      code: 'a2ui-store/not-found',
    })
  })

  it('re-renders a saved tool by appending a fresh surface event', async () => {
    const { agent, append } = agentStub()
    const ctx = freshContext(agent)
    ctx.provide('a2uiStore', {
      dir: '/tmp',
      list: vi.fn(async () => [{ name: 'tool-1', page: PAGE, savedAt: '' }]),
    } as unknown as A2uiStore)
    const controller = new A2uiStoreController(ctx)
    const result = await controller.open({ sessionId: SessionId('s1'), name: 'tool-1' })
    expect(result.name).toBe('tool-1')
    expect(typeof result.surfaceId).toBe('string')
    expect(append).toHaveBeenCalledWith('a2ui/surface', { surfaceId: result.surfaceId, page: PAGE })
  })

  it('deletes a tool', async () => {
    const ctx = freshContext(undefined)
    const remove = vi.fn(async () => true)
    ctx.provide('a2uiStore', { dir: '/tmp', remove } as unknown as A2uiStore)
    const controller = new A2uiStoreController(ctx)
    await expect(controller.delete({ name: 'a' })).resolves.toEqual({ removed: true })
    remove.mockResolvedValueOnce(false)
    await expect(controller.delete({ name: 'a' })).resolves.toEqual({ removed: false })
  })
})

describe('A2uiRunController', () => {
  it('refuses to start without a live agent', async () => {
    const ctx = freshContext(undefined)
    ctx.provide('a2uiRun', { start: vi.fn(() => ({ runId: 'run-1' })) } as unknown as A2uiRun)
    const controller = new A2uiRunController(ctx)
    await expect(controller.start({
      command: 'echo hi', fields: {}, sessionId: SessionId('s1'), surfaceId: 'surf',
    })).rejects.toMatchObject({ code: 'a2ui-run/agent-offline' })
  })

  it('starts a run with the session workspace and surface correlation', async () => {
    const { agent, append } = agentStub('/mnt/workspace')
    const ctx = freshContext(agent)
    let captured: A2uiRunStart | undefined
    const start = vi.fn((request: A2uiRunStart) => { captured = request; return { runId: 'run-1' } })
    ctx.provide('a2uiRun', { start } as unknown as A2uiRun)
    const controller = new A2uiRunController(ctx)
    await expect(controller.start({
      command: 'echo {x}', fields: { x: 'hi' }, timeoutMs: 5000, sessionId: SessionId('s1'), surfaceId: 'surf',
    })).resolves.toEqual({ runId: 'run-1' })
    const request = captured as A2uiRunStart
    expect(request.command).toBe('echo {x}')
    expect(request.fields).toEqual({ x: 'hi' })
    expect(request.timeoutMs).toBe(5000)
    expect(request.surfaceId).toBe('surf')
    const session = request.session
    expect(session.cwd).toBe('/mnt/workspace')
    // The adapter forwards an append to the owning session.
    const data = { surfaceId: 'surf', phase: 'started' as const, seq: 0 }
    session.append('a2ui/update', data)
    expect(append).toHaveBeenCalledWith('a2ui/update', data)
  })

  it('re-throws an unexpected start error', async () => {
    const { agent } = agentStub()
    const ctx = freshContext(agent)
    ctx.provide('a2uiRun', { start: vi.fn(() => { throw new Error('unexpected') }) } as unknown as A2uiRun)
    const controller = new A2uiRunController(ctx)
    await expect(controller.start({
      command: 'echo hi', fields: {}, sessionId: SessionId('s1'), surfaceId: 'surf',
    })).rejects.toThrow('unexpected')
  })

  it('maps a missing shell to the shell-unavailable error', async () => {
    const { agent } = agentStub()
    const ctx = freshContext(agent)
    ctx.provide('a2uiRun', {
      start: vi.fn(() => { throw new Error('a2uiRun: no shell service is mounted; a `command` action cannot run') }),
    } as unknown as A2uiRun)
    const controller = new A2uiRunController(ctx)
    await expect(controller.start({
      command: 'echo hi', fields: {}, sessionId: SessionId('s1'), surfaceId: 'surf',
    })).rejects.toMatchObject({ code: 'a2ui-run/shell-unavailable' })
  })

  it('maps an invalid command template to the invalid-command error', async () => {
    const { agent } = agentStub()
    const ctx = freshContext(agent)
    ctx.provide('a2uiRun', {
      start: vi.fn(() => { throw new Error('a2ui command action: placeholder {x} has no matching field') }),
    } as unknown as A2uiRun)
    const controller = new A2uiRunController(ctx)
    await expect(controller.start({
      command: 'echo {x}', fields: {}, sessionId: SessionId('s1'), surfaceId: 'surf',
    })).rejects.toMatchObject({ code: 'a2ui-run/invalid-command' })
  })

  it('reads, stops, and runs a script through the capability', async () => {
    const { agent } = agentStub()
    const ctx = freshContext(agent)
    const read = vi.fn(() => ({ seq: 1, output: 'out', running: true, exitCode: null, lossy: false }))
    const stop = vi.fn(() => true)
    ctx.provide('a2uiRun', { read, stop } as unknown as A2uiRun)
    ctx.provide('a2uiRunScript', { run: vi.fn(async () => ({ value: 1, logs: [] })) } as unknown as A2uiRunScript)
    const controller = new A2uiRunController(ctx)
    await expect(controller.read({ runId: 'run-1' })).resolves.toEqual({ runId: 'run-1', seq: 1, output: 'out', running: true, exitCode: null, lossy: false })
    await expect(controller.stop({ runId: 'run-1' })).resolves.toEqual({ runId: 'run-1', requested: true })
    await expect(controller.runScript({ program: 'x', binds: [], fields: {} })).resolves.toEqual({ value: 1, logs: [] })
  })

  it('maps unknown run reads and stops to the not-found error', async () => {
    const { agent } = agentStub()
    const ctx = freshContext(agent)
    ctx.provide('a2uiRun', {
      read: vi.fn(() => { throw new Error('a2uiRun: unknown run "run-1"') }),
      stop: vi.fn(() => { throw new Error('a2uiRun: unknown run "run-1"') }),
    } as unknown as A2uiRun)
    const controller = new A2uiRunController(ctx)
    await expect(controller.read({ runId: 'run-1' })).rejects.toMatchObject({ code: 'a2ui-run/not-found' })
    await expect(controller.stop({ runId: 'run-1' })).rejects.toMatchObject({ code: 'a2ui-run/not-found' })
  })

  it('maps a missing code runtime to the runtime-unavailable error', async () => {
    const { agent } = agentStub()
    const ctx = freshContext(agent)
    ctx.provide('a2uiRunScript', {
      run: vi.fn(async () => { throw new Error('a2uiRunScript: no code runtime') }),
    } as unknown as A2uiRunScript)
    const controller = new A2uiRunController(ctx)
    await expect(controller.runScript({ program: 'x', binds: [], fields: {} })).rejects.toMatchObject({
      code: 'a2ui-run-script/runtime-unavailable',
    })
  })

  it('re-throws unexpected read, stop, and runScript errors', async () => {
    const { agent } = agentStub()
    const ctx = freshContext(agent)
    ctx.provide('a2uiRun', {
      read: vi.fn(() => { throw new Error('read boom') }),
      stop: vi.fn(() => { throw new Error('stop boom') }),
    } as unknown as A2uiRun)
    ctx.provide('a2uiRunScript', { run: vi.fn(async () => { throw new Error('script boom') }) } as unknown as A2uiRunScript)
    const controller = new A2uiRunController(ctx)
    await expect(controller.read({ runId: 'run-1' })).rejects.toThrow('read boom')
    await expect(controller.stop({ runId: 'run-1' })).rejects.toThrow('stop boom')
    await expect(controller.runScript({ program: 'x', binds: [], fields: {} })).rejects.toThrow('script boom')
  })
})
