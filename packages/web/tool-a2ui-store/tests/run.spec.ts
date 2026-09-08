/** Behavior of the A2UI command runner: template filling, shell quoting, and the shell-backed capability over a stub. */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { fillA2uiCommand } from '../src/run.ts'
import { ShellA2uiRun } from '../src/run.ts'

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

/** Build a context whose shell service starts a fake ShellProcess over live spies. */
function stubHarness(): {
  ctx: { get: () => unknown }
  read: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
} {
  const read = vi.fn(() => ({ delta: '', lossy: false }))
  const kill = vi.fn(() => true)
  const shell = {
    resolve: (request: { command: string }): { command: string } => ({ command: request.command }),
    start: () => ({ readOutput: read, kill, exitCode: null }),
  }
  return { ctx: { get: () => shell }, read, kill }
}

describe('ShellA2uiRun', () => {
  it('starts a resolved command, reads consuming chunks, and stops the process', () => {
    const harness = stubHarness()
    const run = new ShellA2uiRun(harness.ctx as unknown as Context)
    const handle = run.start('echo {x}', { x: 'hello' })
    expect(handle.command).toBe("echo 'hello'")
    expect(handle.seq).toBe(0)

    // First read reports the process live with no output yet.
    expect(run.read(handle.runId)).toMatchObject({ seq: 1, running: true, exitCode: null, output: '' })

    // A later chunk is consumed once.
    harness.read.mockReturnValue({ delta: 'line1\n', lossy: false })
    expect(run.read(handle.runId)).toMatchObject({ seq: 2, output: 'line1\n', running: true })

    // Stop asks the live process to terminate.
    expect(run.stop(handle.runId)).toBe(true)
    expect(harness.kill).toHaveBeenCalledTimes(1)
    expect(run.get(handle.runId).runId).toBe(handle.runId)

    // Unknown runs fail loud on every verb.
    expect(() => run.read('nope')).toThrow(/unknown run/)
    expect(() => run.stop('nope')).toThrow(/unknown run/)
    expect(() => run.get('nope')).toThrow(/unknown run/)
  })

  it('throws a clear error when no shell executor is mounted', () => {
    const run = new ShellA2uiRun({ get: () => undefined } as unknown as Context)
    expect(() => run.start('echo hi', {})).toThrow(/no shell service is mounted/)
  })
})
