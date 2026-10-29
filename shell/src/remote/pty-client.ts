/**
 * Remote terminal client: one `SubprocessTerminalHandle` whose bytes travel
 * over the hub instead of a local PTY, so a browser terminal opened in a
 * mounted workspace runs the shell on the paired device.
 *
 * The hub relays NDJSON: `pty:opened` acknowledges allocation, base64
 * `pty:data` frames carry output, and `pty:exit` ends the session. Input,
 * resize and termination are separate fire-and-forget control requests
 * addressed by the same terminal id.
 *
 * Activity and foreground observation stay `unknown`/absent: the agent's PTY
 * does not report shell lifecycle, so automatic reclamation never treats a
 * remote terminal as idle. Retaining one costs terminal quota until the user
 * closes it, which is the conservative direction for a live user shell.
 *
 * @module dsh-team-shell/pty-client
 */

import { Readable } from 'node:stream'
import type {
  SubprocessOutcome,
  SubprocessTerminalActivity,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
} from '@deepseek-ai/dsh-subprocess'

/** The hub control endpoint a remote terminal talks to. */
export interface RemotePtyConfig {
  /** Hub control API base, e.g. `http://127.0.0.1:7100`. */
  hubUrl: string
  /** User whose agent serves the terminal; the hub addresses agents by owner. */
  user: string
  /** Specific agent id; omitted lets the hub choose the user's single online agent. */
  agentId?: string | undefined
}

/** Allocation request for one remote terminal. */
export interface RemotePtyRequest {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly terminalType: string
  readonly env?: Record<string, string> | undefined
  readonly signal?: AbortSignal | undefined
}

/** Terminal allocation or live transport failed. */
export class RemotePtyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemotePtyError'
  }
}

/** Post one fire-and-forget control frame and await only its acknowledgement. */
async function control(config: RemotePtyConfig, path: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${config.hubUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: config.user,
      ...body,
      ...config.agentId === undefined ? {} : { agentId: config.agentId },
    }),
  })
  if (!response.ok) throw new RemotePtyError(`hub ${path} answered ${String(response.status)}: ${await response.text()}`)
}

/** The subset of relayed frames this client reads. */
interface HubFrame {
  type?: string
  data?: string
  code?: number | null
  signal?: string | null
  message?: string
  pid?: number
}

/** One remote terminal: output arrives on `output`, mutations post control frames. */
export class RemoteTerminalHandle implements SubprocessTerminalHandle {
  /** Resolves when the terminal exits; rejects for a startup or live transport failure. */
  readonly done: Promise<SubprocessOutcome>
  /** Terminal output bytes in delivery order; ends after queued output. */
  readonly output: Readable
  private readonly settled: PromiseWithResolvers<SubprocessOutcome>
  private closed = false

  constructor(
    private readonly config: RemotePtyConfig,
    /** Terminal identity the hub and agent address. */
    readonly id: string,
    /** Top-level process id reported by the agent. */
    readonly pid: number,
    output: Readable,
    settled: PromiseWithResolvers<SubprocessOutcome>,
  ) {
    this.output = output
    this.settled = settled
    this.done = settled.promise
  }

  /** @inheritdoc */
  async write(data: string): Promise<void> {
    if (this.closed) return
    await control(this.config, '/api/pty-write', { id: this.id, data: Buffer.from(data, 'utf8').toString('base64') })
  }

  /** @inheritdoc */
  async resize(cols: number, rows: number): Promise<void> {
    if (this.closed) return
    await control(this.config, '/api/pty-resize', { id: this.id, cols, rows })
  }

  /**
   * The agent reports no foreground group for a terminal session.
   * @returns undefined, the seam's "no resolvable foreground group".
   */
  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return undefined
  }

  /**
   * Remote terminals report no shell activity, so reclamation never treats one as idle.
   * @returns the unknown observation the seam defines for unsupported shells.
   */
  async inspectActivity(): Promise<SubprocessTerminalActivity> {
    return { state: 'unknown', revision: 0 }
  }

  /**
   * Reject a foreground signal: the agent owns the process tree and publishes no group id.
   * @param _signal - the requested terminal signal, unused here.
   * @returns never returns; the seam has no propagation path over this transport.
   */
  async signalForeground(_signal: SubprocessTerminalSignal): Promise<number> {
    throw new RemotePtyError('remote terminals do not expose a foreground process group')
  }

  /** @inheritdoc */
  async terminate(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      try {
        await control(this.config, '/api/kill', { id: this.id })
      } catch (error) {
        // A channel already gone cannot kill anything; the agent releases its
        // terminals when the socket closes, so only report the transport
        // failure when the terminal never reported its own exit.
        void error
      }
    }
    await this.settled.promise.catch(() => {
      // A rejected terminal already reported its failure to every observer.
    })
  }
}

/**
 * Allocate one terminal on the user's device through the hub.
 * @param config - hub endpoint and optional agent selection.
 * @param request - argv, directory, dimensions, environment, and cancellation.
 * @returns the live handle once the agent acknowledges allocation.
 */
export async function openRemoteTerminal(config: RemotePtyConfig, request: RemotePtyRequest): Promise<RemoteTerminalHandle> {
  const id = crypto.randomUUID()
  const response = await fetch(`${config.hubUrl}/api/pty`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: config.user,
      // The same id addresses this terminal for input, resize and termination,
      // so the agent can match those control frames to the allocation.
      id,
      argv: request.argv, cwd: request.cwd, cols: request.cols, rows: request.rows,
      terminalType: request.terminalType,
      ...config.agentId === undefined ? {} : { agentId: config.agentId },
      ...request.env === undefined ? {} : { env: request.env },
    }),
    ...request.signal === undefined ? {} : { signal: request.signal },
  })
  if (!response.ok) throw new RemotePtyError(`hub /api/pty answered ${String(response.status)}: ${await response.text()}`)
  const body = response.body
  if (body === null) throw new RemotePtyError('hub terminal response has no body')

  const output = new Readable({ read() {} })
  const settled = Promise.withResolvers<SubprocessOutcome>()
  // An allocation that fails never hands out a handle, so `done` rejects with
  // no observer; keep that from surfacing as an unhandled rejection while still
  // rejecting it for callers that do await `done`.
  void settled.promise.catch(() => {})
  const opened = Promise.withResolvers<number>()
  const reader = body.getReader()
  const decoder = new TextDecoder()

  /** Settle every observer once: the byte stream ends and `done` reports why. */
  let finished = false
  const close = (outcome: SubprocessOutcome | Error): void => {
    if (finished) return
    finished = true
    output.push(null)
    if (outcome instanceof Error) settled.reject(outcome)
    else settled.resolve(outcome)
    void reader.cancel().catch(() => {
      // The channel already closed; there is nothing left to release.
    })
  }

  void (async () => {
    let pending = ''
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        pending += decoder.decode(chunk.value, { stream: true })
        let nl: number
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl)
          pending = pending.slice(nl + 1)
          if (line.length === 0) continue
          let frame: HubFrame
          try {
            frame = JSON.parse(line) as HubFrame
          } catch {
            continue
          }
          if (frame.type === 'pty:opened') {
            opened.resolve(typeof frame.pid === 'number' ? frame.pid : 0)
            continue
          }
          if (frame.type === 'pty:data' && typeof frame.data === 'string') {
            output.push(Buffer.from(frame.data, 'base64'))
            continue
          }
          if (frame.type === 'request-error') {
            opened.reject(new RemotePtyError(frame.message ?? 'terminal request failed'))
            close(new RemotePtyError(frame.message ?? 'terminal request failed'))
            return
          }
          if (frame.type === 'pty:exit') {
            close({ exitCode: frame.code ?? null, signal: (frame.signal ?? null) as NodeJS.Signals | null })
            return
          }
        }
      }
      // The channel ended without an exit frame: the transport dropped.
      opened.reject(new RemotePtyError('terminal channel closed before allocation was acknowledged'))
      close(new RemotePtyError('terminal channel closed without reporting an exit'))
    } catch (error) {
      const failure = error instanceof Error ? error : new RemotePtyError(String(error))
      opened.reject(failure)
      close(failure)
    }
  })()

  let pid: number
  try {
    pid = await opened.promise
  } catch (error) {
    throw error instanceof Error ? error : new RemotePtyError(String(error))
  }
  return new RemoteTerminalHandle(config, id, pid, output, settled)
}
