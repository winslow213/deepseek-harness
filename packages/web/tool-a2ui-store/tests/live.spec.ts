/** Behavior of the A2UI live-result streamer: attach, delta polling, and terminal settle over a stubbed jobs service. */

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { describe, expect, it, vi } from 'vitest'
import { ShellA2uiLive } from '../src/live.ts'
import type { A2uiUpdateData } from '../src/types.ts'

/** A minimal agent whose session records every append. */
function agentStub(): { agent: Agent; updates: A2uiUpdateData[] } {
  const updates: A2uiUpdateData[] = []
  const append = (type: string, data: A2uiUpdateData): void => { if (type === 'a2ui/update') updates.push(data) }
  const agent = { id: SessionId('s1'), session: { append } } as unknown as Agent
  return { agent, updates }
}

describe('ShellA2uiLive', () => {
  it('throws when no jobs service is mounted', () => {
    const live = new ShellA2uiLive(new Context())
    const { agent } = agentStub()
    expect(() => live.attach('surf', 'bash-1' as JobId, agent)).toThrow(/no jobs service is mounted/)
  })

  it('refuses an unknown or foreign job before opening a reader', () => {
    const ctx = new Context()
    ctx.provide('jobs', { get: vi.fn(() => { throw new Error('unknown job') }), openOutputReader: vi.fn() } as never)
    const live = new ShellA2uiLive(ctx)
    const { agent } = agentStub()
    expect(() => live.attach('surf', 'bash-99' as JobId, agent)).toThrow(/unknown job/)
  })

  it('emits started, deltas, and finished over the independent reader', () => {
    vi.useFakeTimers()
    try {
      const { agent, updates } = agentStub()
      const deltas: string[] = []
      let status = 'running'
      const ctx = new Context()
      ctx.provide('jobs', {
        get: vi.fn(() => ({ status })),
        openOutputReader: vi.fn(() => ({ read: () => deltas.shift() ?? '' })),
      } as never)
      const live = new ShellA2uiLive(ctx)

      live.attach('surf', 'bash-1' as JobId, agent)
      expect(updates[0]).toEqual({ surfaceId: 'surf', phase: 'started', seq: 0, totalBytes: 0 })

      deltas.push('line1\n')
      vi.advanceTimersByTime(250)
      expect(updates[1]).toEqual({ surfaceId: 'surf', phase: 'delta', seq: 1, delta: 'line1\n', totalBytes: 6 })

      status = 'completed'
      vi.advanceTimersByTime(250)
      expect(updates[2]).toEqual({ surfaceId: 'surf', phase: 'finished', seq: 2, totalBytes: 6 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles aborted when the job is killed', () => {
    vi.useFakeTimers()
    try {
      const { agent, updates } = agentStub()
      const status = 'killed'
      const ctx = new Context()
      ctx.provide('jobs', {
        get: vi.fn(() => ({ status })),
        openOutputReader: vi.fn(() => ({ read: () => '' })),
      } as never)
      const live = new ShellA2uiLive(ctx)
      live.attach('surf', 'bash-1' as JobId, agent)
      vi.advanceTimersByTime(250)
      expect(updates[1]).toEqual({ surfaceId: 'surf', phase: 'aborted', seq: 1, totalBytes: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles finished for a failed job status', () => {
    vi.useFakeTimers()
    try {
      const { agent, updates } = agentStub()
      const status = 'failed'
      const ctx = new Context()
      ctx.provide('jobs', {
        get: vi.fn(() => ({ status })),
        openOutputReader: vi.fn(() => ({ read: () => '' })),
      } as never)
      const live = new ShellA2uiLive(ctx)
      live.attach('surf', 'bash-1' as JobId, agent)
      vi.advanceTimersByTime(250)
      expect(updates[1]).toEqual({ surfaceId: 'surf', phase: 'finished', seq: 1, totalBytes: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles aborted when the reader throws mid-stream', () => {
    vi.useFakeTimers()
    try {
      const { agent, updates } = agentStub()
      const ctx = new Context()
      ctx.provide('jobs', {
        get: vi.fn(() => ({ status: 'running' })),
        openOutputReader: vi.fn(() => ({ read: () => { throw new Error('gone') } })),
      } as never)
      const live = new ShellA2uiLive(ctx)
      live.attach('surf', 'bash-1' as JobId, agent)
      vi.advanceTimersByTime(250)
      expect(updates[1]).toEqual({ surfaceId: 'surf', phase: 'aborted', seq: 0, totalBytes: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles aborted when the jobs service disappears mid-stream', () => {
    vi.useFakeTimers()
    try {
      const { agent, updates } = agentStub()
      const jobs = { get: vi.fn(() => ({ status: 'running' })), openOutputReader: vi.fn(() => ({ read: () => '' })) }
      const get = vi.fn().mockReturnValueOnce(jobs).mockReturnValue(undefined)
      const live = new ShellA2uiLive({ get } as unknown as Context)
      live.attach('surf', 'bash-1' as JobId, agent)
      vi.advanceTimersByTime(250)
      expect(updates[1]).toEqual({ surfaceId: 'surf', phase: 'aborted', seq: 1, totalBytes: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-attaching a surface replaces its prior stream without duplicating settles', () => {
    vi.useFakeTimers()
    try {
      const { agent, updates } = agentStub()
      let status = 'running'
      const ctx = new Context()
      ctx.provide('jobs', {
        get: vi.fn(() => ({ status })),
        openOutputReader: vi.fn(() => ({ read: () => '' })),
      } as never)
      const live = new ShellA2uiLive(ctx)
      live.attach('surf', 'bash-1' as JobId, agent)
      live.attach('surf', 'bash-2' as JobId, agent)
      status = 'completed'
      vi.advanceTimersByTime(250)
      // One started per attach, then a single finished settle.
      expect(updates.filter(update => update.phase === 'started')).toHaveLength(2)
      expect(updates.filter(update => update.phase === 'finished')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
