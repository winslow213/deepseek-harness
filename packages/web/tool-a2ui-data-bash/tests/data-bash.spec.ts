/** Behavior of the bash data-source provider: command filling, stdout parsing, and the shell-backed resolve. */

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { BashA2uiDataProvider, fillCommand, parseOptions } from '../src/index.ts'

describe('fillCommand', () => {
  it('replaces placeholders with single-quoted words', () => {
    expect(fillCommand('hdc -t {sn} list targets', { sn: 'abc-123' }))
      .toBe("hdc -t 'abc-123' list targets")
  })

  it('quotes a value containing a single quote with the POSIX splice', () => {
    expect(fillCommand('echo {who}', { who: "it's" })).toBe("echo 'it'\\''s'")
  })

  it('turns null, number, and boolean values into shell words', () => {
    expect(fillCommand('{a} {b} {c}', { a: null, b: 12, c: true }))
      .toBe("'' '12' 'true'")
  })

  it('refuses an unknown placeholder rather than running a partial command', () => {
    expect(() => fillCommand('echo {missing}', {})).toThrow(/placeholder \{missing\} has no matching field/)
  })
})

describe('parseOptions', () => {
  it('parses a JSON array of label/value records', () => {
    expect(parseOptions('[{"label":"a","value":"1"},{"label":"b","value":"2"}]'))
      .toEqual([{ label: 'a', value: '1' }, { label: 'b', value: '2' }])
  })

  it('parses a JSON { items: [...] } envelope', () => {
    expect(parseOptions('{"items":[{"label":"a","value":"1"}]}'))
      .toEqual([{ label: 'a', value: '1' }])
  })

  it('splits non-JSON output into trimmed lines, each a label/value option', () => {
    expect(parseOptions('  device-1\n device-2  \n\n')).toEqual([
      { label: 'device-1', value: 'device-1' },
      { label: 'device-2', value: 'device-2' },
    ])
  })

  it('skips entries that are not label/value records', () => {
    expect(parseOptions('[{"label":"ok","value":"1"},{"label":"","value":""},7,"x"]'))
      .toEqual([{ label: 'ok', value: '1' }])
  })
})

describe('BashA2uiDataProvider', () => {
  function stubShell(run: ReturnType<typeof vi.fn>): { get: () => unknown } {
    return {
      get: () => ({
        resolve: (request: { command: string; timeoutMs?: number }) => ({
          command: request.command,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        }),
        run,
      }),
    }
  }

  it('serves whitelisted sources and refuses unknown ones', () => {
    const provider = new BashA2uiDataProvider({ get: () => undefined } as unknown as Context, {
      'hdc-devices': { command: 'hdc list targets' },
    })
    expect(provider.has('hdc-devices')).toBe(true)
    expect(provider.has('nope')).toBe(false)
  })

  it('resolves a source by running its filled command through the shell', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: { text: '{"items":[{"label":"a","value":"1"}]}', truncated: false }, stderr: { text: '' } }))
    const provider = new BashA2uiDataProvider(stubShell(run) as unknown as Context, {
      'hdc-devices': { command: 'hdc list targets' },
    })
    await expect(provider.resolve('hdc-devices', {})).resolves.toEqual({ items: [{ label: 'a', value: '1' }] })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: 'hdc list targets' }))
  })

  it('rejects a source whose command exits nonzero with the stderr detail', async () => {
    const run = vi.fn(async () => ({ exitCode: 1, stdout: { text: '', truncated: false }, stderr: { text: 'no devices' } }))
    const provider = new BashA2uiDataProvider(stubShell(run) as unknown as Context, {
      'hdc-devices': { command: 'hdc list targets' },
    })
    await expect(provider.resolve('hdc-devices', {})).rejects.toThrow(/no devices/)
  })

  it('rejects when no shell service is mounted', async () => {
    const provider = new BashA2uiDataProvider({ get: () => undefined } as unknown as Context, {
      'hdc-devices': { command: 'hdc list targets' },
    })
    await expect(provider.resolve('hdc-devices', {})).rejects.toThrow(/no shell service/)
  })
})
