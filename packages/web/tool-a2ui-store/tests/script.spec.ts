/** Behavior of the A2UI script runner: the code-runtime-backed capability over a stub. */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { CodeA2uiRunScript } from '../src/script.ts'

/** A stub code runtime that resolves one program with a JSON value. */
function stubRuntime(result: { value?: unknown; logs?: string[]; error?: { kind: string; message: string } }) {
  const run = vi.fn(async () => ({
    value: result.value,
    logs: result.logs ?? [],
    error: result.error,
  }))
  return { run, ctx: { get: () => ({ run }) } }
}

describe('CodeA2uiRunScript', () => {
  it('runs a program against only the granted bindings and returns its JSON value', async () => {
    const stub = stubRuntime({ value: { ok: true, n: 3 } })
    const cap = new CodeA2uiRunScript(stub.ctx as unknown as Context)
    const out = await cap.run('return { ok: a2ui.text("x") === "X", n: 3 }', ['text'], {})
    expect(out.value).toEqual({ ok: true, n: 3 })
    expect(out.logs).toEqual([])
    expect(stub.run).toHaveBeenCalledOnce()
    const request = stub.run.mock.calls[0]![0] as { bindings: Array<{ global: string; functions: Record<string, unknown> }> }
    expect(request.bindings).toHaveLength(1)
    expect(request.bindings[0]!.global).toBe('a2ui')
    expect(Object.keys(request.bindings[0]!.functions).sort()).toEqual(['text'])
  })

  it('surfaces a runtime failure detail', async () => {
    const stub = stubRuntime({ error: { kind: 'timeout', message: 'wall-clock ceiling' } })
    const cap = new CodeA2uiRunScript(stub.ctx as unknown as Context)
    const out = await cap.run('while (true) {}', [], {})
    expect(out.value).toBeUndefined()
    expect(out.error).toEqual({ kind: 'timeout', message: 'wall-clock ceiling' })
  })

  it('throws a clear error when no code runtime is mounted', async () => {
    const cap = new CodeA2uiRunScript({ get: () => undefined } as unknown as Context)
    await expect(cap.run('return 1', [], {})).rejects.toThrow(/no code runtime is mounted/)
  })

  it('passes only the granted bindings, dropping any ungranted name', async () => {
    const stub = stubRuntime({ value: 1 })
    const cap = new CodeA2uiRunScript(stub.ctx as unknown as Context)
    await cap.run('return 1', ['text', 'fetch'], {})
    const request = stub.run.mock.calls[0]![0] as { bindings: Array<{ functions: Record<string, unknown> }> }
    expect(Object.keys(request.bindings[0]!.functions).sort()).toEqual(['fetch', 'text'])
  })
})
