/**
 * Host execution of A2UI live-result streaming: attach one background job's
 * output stream to a surface and emit a bounded `a2ui/update` event per polled
 * delta until the job settles. The poll reads an independent reader
 * (`ctx.jobs.openOutputReader`), so the model's own `job_output` reads never
 * consume the streamed deltas; the stream is the durable, replayable live view
 * a `model`-action job shows in its popup.
 * @module @deepseek-ai/dsh-tool-a2ui-store/live
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId } from '@deepseek-ai/dsh-jobs'

const POLL_MS = 250

/** Count UTF-8 bytes of one delta for the cumulative throughput label. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** One attached live stream: the independent reader plus the run state it emits. */
interface LiveStream {
  readonly surfaceId: string
  readonly jobId: JobId
  readonly reader: { read(): string }
  /** Monotonic sequence of the emitted events for this stream. */
  seq: number
  /** Cumulative byte count of the emitted deltas. */
  totalBytes: number
  timer: ReturnType<typeof setInterval> | null
  settled: boolean
}

/** Host capability backing A2UI live-result streaming over `ctx.jobs`. */
export interface A2uiLive {
  /**
   * Attach one background job's output to a surface: emits a `started` event
   * now, then one `delta` per polled output chunk, then `finished`/`aborted`
   * when the job settles. Re-attaching a surface replaces its prior stream.
   * @param surfaceId - the stable surface identity the events correlate with.
   * @param jobId - the background job the model just started.
   * @param agent - the owning agent (supplies session and job authorization).
   * @throws when no jobs service is mounted or the job is unknown/foreign.
   */
  attach(surfaceId: string, jobId: JobId, agent: Agent): void
}

/**
 * The jobs-service-backed live-result capability registered on `ctx.a2uiLive`.
 * The jobs service is resolved lazily so the plugin mounts in compositions that
 * carry no background jobs; only an actual attach needs one.
 */
export class ShellA2uiLive implements A2uiLive {
  private readonly streams = new Map<string, LiveStream>()

  /** @param ctx - registrant context that may acquire the jobs service. */
  constructor(private readonly ctx: Context) {}

  attach(surfaceId: string, jobId: JobId, agent: Agent): void {
    const jobs = this.ctx.get('jobs')
    if (jobs === undefined) {
      throw new Error('a2ui live results: no jobs service is mounted; a `model` action job cannot stream')
    }
    jobs.get(jobId, agent) // throws for an unknown or foreign job
    const reader = jobs.openOutputReader(jobId, agent)

    const prior = this.streams.get(surfaceId)
    if (prior !== undefined && prior.timer !== null) clearInterval(prior.timer)

    const stream: LiveStream = {
      surfaceId, jobId, reader, seq: 0, totalBytes: 0, timer: null, settled: false,
    }
    this.streams.set(surfaceId, stream)
    agent.session.append('a2ui/update', { surfaceId, phase: 'started', seq: 0, totalBytes: 0 })

    stream.timer = setInterval(() => { this.poll(stream, agent) }, POLL_MS)
  }

  /** Poll one stream: emit a delta, then settle when the job reaches a terminal status. */
  private poll(stream: LiveStream, agent: Agent): void {
    try {
      let delta = ''
      delta = stream.reader.read()
      stream.seq += 1
      stream.totalBytes += byteLength(delta)
      if (delta.length > 0) {
        agent.session.append('a2ui/update', {
          surfaceId: stream.surfaceId, phase: 'delta', seq: stream.seq, delta, totalBytes: stream.totalBytes,
        })
      }
      const jobs = this.ctx.get('jobs')
      if (jobs === undefined) {
        this.settle(stream, agent, 'aborted')
        return
      }
      const status = jobs.get(stream.jobId, agent).status
      if (status === 'killed') {
        this.settle(stream, agent, 'aborted')
      } else if (status === 'completed' || status === 'failed') {
        this.settle(stream, agent, 'finished')
      }
    } catch {
      // A teardown-removed job or a reader failure settles the stream aborted;
      // the interval callback must never throw into the event loop.
      this.settle(stream, agent, 'aborted')
    }
  }

  /** Emit the terminal event once and stop polling. */
  private settle(stream: LiveStream, agent: Agent, phase: 'finished' | 'aborted'): void {
    // A settle clears the timer and drops the stream, so no later poll can
    // reach a second settle for the same stream; the guard is defensive.
    /* v8 ignore next -- a settled stream is never polled again */
    if (stream.settled) return
    stream.settled = true
    /* v8 ignore next -- settle only runs from a live poll, where the timer is set */
    if (stream.timer !== null) clearInterval(stream.timer)
    stream.timer = null
    agent.session.append('a2ui/update', {
      surfaceId: stream.surfaceId, phase, seq: stream.seq, totalBytes: stream.totalBytes,
    })
    this.streams.delete(stream.surfaceId)
  }
}
