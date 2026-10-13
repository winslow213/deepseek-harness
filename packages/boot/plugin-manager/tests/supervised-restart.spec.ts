/**
 * Self-restart protocol: the marker a supervised instance writes for a change
 * it cannot apply live, and the exit that makes the supervisor relaunch.
 * The unit is a spawned child, because the behavior under test IS process
 * termination — an injected hook would prove the opposite of what matters.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DSH_SUPERVISED_ENV, RESTART_MARKER } from '../src/supervised-restart.ts'

const CHILD = fileURLToPath(new URL('./fixtures/supervised-restart-child.ts', import.meta.url))

/** A throwaway profile directory, removed when its test ends. */
function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'supervised-restart-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

/** Run the child once with `DSH_SUPERVISED` set to `value`, absent when undefined. */
function runWithSupervision(value: string | undefined): {
  dir: string
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
} {
  const dir = profile()
  const env: NodeJS.ProcessEnv = { ...process.env }
  Reflect.deleteProperty(env, DSH_SUPERVISED_ENV)
  if (value !== undefined) env[DSH_SUPERVISED_ENV] = value
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx/esm'), CHILD, dir], {
    encoding: 'utf8', env, timeout: 20_000,
  })
  return { dir, status: result.status, signal: result.signal, stdout: result.stdout }
}

describe('requestRestartIfSupervised', () => {
  it('writes the marker and self-terminates under a supervisor', () => {
    const { dir, signal, stdout } = runWithSupervision('1')
    expect(stdout).toContain('true')
    // The supervisor relaunches on the marker, so the exit signal is only how
    // the live process steps aside; SIGTERM is the stop request it expects.
    expect(signal).toBe('SIGTERM')
    const written = readFileSync(join(dir, RESTART_MARKER), 'utf8')
    expect(Number.isNaN(Date.parse(written.trim()))).toBe(false)
  }, 30_000)

  it('stays dormant with no supervisor contract', () => {
    const { dir, status, signal, stdout } = runWithSupervision(undefined)
    expect(stdout).toContain('false')
    expect(status).toBe(0)
    expect(signal).toBeNull()
    expect(existsSync(join(dir, RESTART_MARKER))).toBe(false)
  }, 30_000)

  it('requires the exact opt-in value, not merely a set variable', () => {
    const { dir, stdout } = runWithSupervision('0')
    expect(stdout).toContain('false')
    expect(existsSync(join(dir, RESTART_MARKER))).toBe(false)
  }, 30_000)
})
