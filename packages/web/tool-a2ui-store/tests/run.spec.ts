/** Behavior of the A2UI command runner: template filling, shell quoting, workspace workdir, and the shell-backed capability over a stub. */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { fillA2uiCommand } from '../src/run.ts'
import { ShellA2uiRun } from '../src/run.ts'
import type { A2uiRunSession } from '../src/run.ts'
import type { A2uiUpdateData } from '../src/types.ts'

describe('fillA2uiCommand', () => {
  it('replaces placeholders with single-quoted words', () => {
    const command = 'hdc -t {sn} hilog {level}'
    expect(fillA2uiCommand(command, { sn: 'abc-123', level: 'D' }))
      .toBe("hdc -t 'abc-123' hilog 'D'")
  })

  it('quotes a value containing a single quote with the POSIX splice', () => {
    expect(fillA2uiCommand('echo {who}', { who: "it's" })).toBe("echo 'it'\\''s'")
  })

  it('turns null and number values into shell words', () => {
    expect(fillA2uiCommand('{a} {b} {c}', { a: null, b: 12, c: true }))
      .toBe("'' '12' 'true'")
  })

  it('refuses an unknown placeholder rather than running a partial command', () => {
    expect(() => fillA2uiCommand('echo {missing}', {})).toThrow(/placeholder \{missing\} has no matching field/)
  })
})

/** A recording session stub: remembers the cwd and every `a2ui/update` append. */
function stubSession(cwd?: string): { session: A2uiRunSession; updates: A2uiUpdateData[] } {
  const updates: A2uiUpdateData[] = []
  const session: A2uiRunSession = {
    ...cwd === undefined ? {} : { cwd },
    append: (_type, data) => { updates.push(data) },
  }
  return { session, updates }
}

/** Build a context whose shell service starts a fake ShellProcess over live spies. */
function stubHarness(cwd?: string): {
  ctx: { get: () => unknown }
  read: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  resolved: () => { command: string; workdir?: string; timeoutMs?: number }
  updates: A2uiUpdateData[]
  session: A2uiRunSession
  setStatus: (status: 'running' | 'completed' | 'killed') => void
} {
  const read = vi.fn(() => ({ delta: '', lossy: false }))
  const kill = vi.fn(() => true)
  const proc = { readOutput: read, kill, exitCode: null, status: 'running' as 'running' | 'completed' | 'killed' }
  let lastResolved: { command: string; workdir?: string; timeoutMs?: number } = { command: '' }
  const shell = {
    resolve: (request: {
      command: string
      workdir?: string
      timeoutMs?: number
    }): { command: string; workdir?: string; timeoutMs?: number } => {
      lastResolved = request
      return request
    },
    start: () => proc,
  }
  const { session, updates } = stubSession(cwd)
  return {
    ctx: { get: () => shell },
    read,
    kill,
    resolved: () => lastResolved,
    updates,
    session,
    setStatus: (status) => { proc.status = status },
  }
}

describe('ShellA2uiRun', () => {
  it('starts a resolved command, reads consuming chunks, and stops the process', () => {
    const harness = stubHarness()
    const run = new ShellA2uiRun(harness.ctx as unknown as Context)
    const handle = run.start({ command: 'echo {x}', fields: { x: 'hello' }, session: harness.session, surfaceId: 's1' })
    expect(handle.command).toBe("echo 'hello'")
    expect(handle.seq).toBe(0)
    expect(harness.updates).toEqual([{ surfaceId: 's1', phase: 'started', seq: 0, totalBytes: 0 }])

    // First read reports the process live with no output yet (no delta event).
    expect(run.read(handle.runId)).toMatchObject({ seq: 1, running: true, exitCode: null, output: '' })

    // A later chunk is consumed once and appends a delta with cumulative bytes.
    harness.read.mockReturnValue({ delta: 'line1\n', lossy: false })
    expect(run.read(handle.runId)).toMatchObject({ seq: 2, output: 'line1\n', running: true })
    expect(harness.updates[1]).toEqual({ surfaceId: 's1', phase: 'delta', seq: 2, delta: 'line1\n', totalBytes: 6 })

    // Stop asks the live process to terminate and appends the aborted settle.
    expect(run.stop(handle.runId)).toBe(true)
    expect(harness.kill).toHaveBeenCalledTimes(1)
    expect(harness.updates[2]).toEqual({ surfaceId: 's1', phase: 'aborted', seq: 2, totalBytes: 6 })

    // Unknown runs fail loud on every verb.
    expect(() => run.read('nope')).toThrow(/unknown run/)
    expect(() => run.stop('nope')).toThrow(/unknown run/)
    expect(() => run.get('nope')).toThrow(/unknown run/)
  })

  it('runs the command in the session workspace and settles with a finished event', () => {
    const harness = stubHarness('/mnt/workspace')
    const run = new ShellA2uiRun(harness.ctx as unknown as Context)
    const handle = run.start({ command: 'pwd', fields: {}, session: harness.session, surfaceId: 's2' })
    expect(harness.resolved()).toMatchObject({ command: 'pwd', workdir: '/mnt/workspace' })

    harness.setStatus('completed')
    harness.read.mockReturnValue({ delta: 'done\n', lossy: false })
    expect(run.read(handle.runId)).toMatchObject({ running: false })
    expect(harness.updates[2]).toEqual({ surfaceId: 's2', phase: 'finished', seq: 1, totalBytes: 5 })

    // A later read does not duplicate the settle event.
    harness.read.mockReturnValue({ delta: '', lossy: false })
    run.read(handle.runId)
    expect(harness.updates.filter(update => update.phase === 'finished')).toHaveLength(1)
  })

  it('passes the run bound through and settles an externally killed process as aborted', () => {
    const harness = stubHarness()
    const run = new ShellA2uiRun(harness.ctx as unknown as Context)
    const handle = run.start({ command: 'tail -f', fields: {}, timeoutMs: 1000, session: harness.session, surfaceId: 's4' })
    expect(harness.resolved()).toMatchObject({ command: 'tail -f', timeoutMs: 1000 })

    // A signal kill detected on read (no stop call) settles as aborted.
    harness.setStatus('killed')
    harness.read.mockReturnValue({ delta: '', lossy: false })
    expect(run.read(handle.runId)).toMatchObject({ running: false })
    expect(harness.updates[1]).toEqual({ surfaceId: 's4', phase: 'aborted', seq: 1, totalBytes: 0 })
  })

  it('throws a clear error when no shell executor is mounted', () => {
    const run = new ShellA2uiRun({ get: () => undefined } as unknown as Context)
    const { session } = stubSession()
    expect(() => run.start({ command: 'echo hi', fields: {}, session, surfaceId: 's3' }))
      .toThrow(/no shell service is mounted/)
  })
})
