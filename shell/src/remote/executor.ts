/**
 * Remote Service Provider for the bash capability seam over the team hub.
 *
 * Each foreground `run` relays a single command string to the user's
 * remote-agent daemon and streams output back. The command runs through the
 * shell of the workdir's host platform — `bash -c` on POSIX agents, `cmd /c`
 * on Windows agents (whose hosts have no bash) — and the agent's command and
 * path allowlists are the enforcement point (design.md §7.4), so a
 * compromised center still cannot run binaries the operator did not allow or
 * escape the user's `--root`. Background `start` keeps the hub exec stream
 * open for the process lifetime and kills the remote process group through
 * the hub `/api/kill` primitive.
 *
 * @module dsh-team-shell/remote-executor
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { ShellExecutor, type CollectedOutput } from '@deepseek-ai/dsh-shell'
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellProcessRead,
  ShellProcessStatus,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { hubControlBase, runKill } from './client.ts'

/** Plugin config supplied by the injected profile row. */
export interface RemoteShellConfig {
  /** Hub control API base (e.g. `http://127.0.0.1:7100`). */
  hubUrl: string
  /** Hub-registered user id whose remote agent serves this executor. */
  user: string
  /**
   * Hub agent id disambiguating among several agents for the same user; omit
   * when the user has a single agent.
   */
  agentId?: string
  /** Remote working directory for commands that do not override it; must live under the agent `--root`. */
  cwd: string
  /** Default foreground timeout in milliseconds. */
  timeoutMs?: number
  /** Upper bound for per-call timeout overrides. */
  maxTimeoutMs?: number
  /** Per-stream in-memory output cap in bytes. */
  maxOutputBytes?: number
  /**
   * Sandbox mode the permission stack composes against. This executor does
   * not confine locally — the remote agent's command/path allowlists are the
   * fence — so the reported mode is the deployment's declared intent for the
   * agent root (default: write inside the workspace-like root, wider requests
   * ask). `danger-full-access` declares no local fence and never asks.
   */
  sandboxMode?: SandboxMode
}

/** Validated config after defaults and positive-finite checks. */
export interface ResolvedRemoteShellConfig {
  hubUrl: string
  user: string
  agentId?: string
  cwd: string
  timeoutMs: number
  maxTimeoutMs: number
  maxOutputBytes: number
  sandboxMode: SandboxMode
}

function positiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`remote-shell: ${name} must be a positive finite number`)
  }
}

/** Apply defaults and validate a raw plugin config. */
export function resolveRemoteShellConfig(config: RemoteShellConfig): ResolvedRemoteShellConfig {
  if (typeof config.hubUrl !== 'string' || config.hubUrl === '') throw new Error('remote-shell: hubUrl is required')
  if (typeof config.user !== 'string' || config.user === '') throw new Error('remote-shell: user is required')
  if (typeof config.cwd !== 'string' || config.cwd === '') throw new Error('remote-shell: cwd is required')
  const timeoutMs = config.timeoutMs ?? 120_000
  const maxTimeoutMs = config.maxTimeoutMs ?? 600_000
  const maxOutputBytes = config.maxOutputBytes ?? 64_000
  positiveFinite('timeoutMs', timeoutMs)
  positiveFinite('maxTimeoutMs', maxTimeoutMs)
  positiveFinite('maxOutputBytes', maxOutputBytes)
  const sandboxMode = config.sandboxMode ?? 'workspace-write'
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandboxMode)) {
    throw new Error(`remote-shell: invalid sandboxMode ${JSON.stringify(sandboxMode)}`)
  }
  return {
    hubUrl: hubControlBase(config.hubUrl),
    user: config.user,
    ...config.agentId === undefined || config.agentId === '' ? {} : { agentId: config.agentId },
    cwd: config.cwd,
    timeoutMs,
    maxTimeoutMs,
    maxOutputBytes,
    sandboxMode,
  }
}

/**
 * Shell argv for a command that runs on a remote agent host.
 *
 * The remote agent is the operator's own host and its platform is not the
 * server's: a paired Windows machine (agent root like `D:\work`) has no bash,
 * so `bash -c` spawns nothing. The workdir the executor forwards is the
 * translated agent-side path (see `translateShadowPath`), which carries the
 * platform in its separators — drive letters/backslashes mean Windows.
 * Windows commands run through `cmd /c`; everything else keeps `bash -c`.
 */
function shellArgvFor(workdir: string, command: string): string[] {
  const isWindowsWorkdir = /^[A-Za-z]:[\\/]/.test(workdir) || workdir.includes('\\')
  return isWindowsWorkdir ? ['cmd', '/c', command] : ['bash', '-c', command]
}

/** One frame of interest from a hub exec NDJSON stream. */
type ExecStreamEvent =
  | { kind: 'stream'; channel: 'stdout' | 'stderr'; data: string; id: string }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'request-error'; message: string }

/** Accumulate a capped output stream the way a collect-mode reader would. */
class CappedOutput {
  private chunks: string[] = []
  private bytes = 0
  truncated = false

  constructor(private readonly maxBytes: number) {}

  push(text: string): void {
    const len = Buffer.byteLength(text)
    if (this.bytes + len <= this.maxBytes) {
      this.chunks.push(text)
      this.bytes += len
      return
    }
    this.truncated = true
    // Retain only the tail: drop oldest chunks until appending fits.
    while (this.bytes + len > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks.shift()
      if (head !== undefined) this.bytes -= Buffer.byteLength(head)
    }
    this.chunks.push(text)
    this.bytes += len
  }

  collect(): CollectedOutput {
    return { text: this.chunks.join(''), truncated: this.truncated }
  }
}

/** Parse and deliver one hub exec NDJSON response. */
async function readExecStream(
  res: Response,
  onEvent: (event: ExecStreamEvent) => void,
): Promise<void> {
  if (!res.ok) {
    throw new Error(`hub returned ${String(res.status)}: ${await res.text()}`)
  }
  const body = res.body
  if (body === null) throw new Error('hub exec response has no body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl)
      pending = pending.slice(nl + 1)
      if (line.length === 0) continue
      const frame = JSON.parse(line) as {
        type?: string; id?: string; channel?: string; data?: string
        code?: number | null; signal?: string | null; message?: string
      }
      if (frame.type === 'stream' && typeof frame.id === 'string') {
        const channel = frame.channel === 'stderr' ? 'stderr' : 'stdout'
        onEvent({ kind: 'stream', channel, data: frame.data ?? '', id: frame.id })
        continue
      }
      if (frame.type === 'exit') {
        onEvent({ kind: 'exit', code: frame.code ?? null, signal: (frame.signal ?? null) as NodeJS.Signals | null })
        return
      }
      if (frame.type === 'request-error') {
        onEvent({ kind: 'request-error', message: frame.message ?? 'request failed' })
        return
      }
    }
  }
  // Stream ended without a terminal frame (channel drop or close).
  onEvent({ kind: 'exit', code: null, signal: null })
}

/**
 * Remote bash executor: one `ctx.shell` provider whose commands execute on the
 * user's own Linux host through the hub. Registering it in a per-user
 * instance replaces the local executor for that instance only (design.md §7.5).
 */
/**
 * A registration-free remote bash runner. Holds no cordis Service identity, so
 * a {@link RegionRouterShellExecutor} (which must register as ctx.shell itself)
 * can compose it without a duplicate-service collision.
 */
export class RemoteShellCore {
  readonly config: ResolvedRemoteShellConfig

  constructor(config: RemoteShellConfig) {
    this.config = resolveRemoteShellConfig(config)
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = Math.min(
      request.timeoutMs ?? this.config.timeoutMs,
      this.config.maxTimeoutMs,
    )
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd,
      timeoutMs,
      stdoutMaxBytes,
      ...request.signal !== undefined ? { signal: request.signal } : {},
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      // This executor never confines: the agent's allowlists are the fence.
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  run(spec: ShellExecSpec): Promise<ShellRunResult> {
    return this.foreground(spec)
  }

  start(spec: ShellExecSpec): ShellProcess {
    return this.background(spec)
  }

  /** POST one exec to the hub and stream its frames. */
  private async execFetch(spec: ShellExecSpec, timeoutMs: number | undefined, signal?: AbortSignal): Promise<{ res: Response; requestId: string }> {
    const requestId = randomUUID()
    const res = await fetch(`${this.config.hubUrl}/api/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        id: requestId,
        user: this.config.user,
        ...this.config.agentId === undefined ? {} : { agentId: this.config.agentId },
        argv: shellArgvFor(spec.workdir, spec.command),
        cwd: spec.workdir,
        ...timeoutMs !== undefined ? { timeoutMs } : {},
      }),
    })
    return { res, requestId }
  }

  /** Settle a foreground run, killing the remote group on abort/timeout. */
  private async foreground(spec: ShellExecSpec): Promise<ShellRunResult> {
    const startedAt = Date.now()
    const stdout = new CappedOutput(spec.stdoutMaxBytes)
    const stderr = new CappedOutput(this.config.maxOutputBytes)
    let timedOut = false
    let aborted = false
    let code: number | null = null
    let sig: NodeJS.Signals | null = null
    let sawTerminal = false
    let requestId: string | undefined

    const killRemote = (): void => {
      if (requestId === undefined) return
      void runKill(this.config.hubUrl, this.config.user, requestId, this.config.agentId).catch(() => {})
    }
    let deadlineTimer: NodeJS.Timeout | undefined
    const onAbort = (): void => {
      aborted = true
      killRemote()
    }
    spec.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const started = await this.execFetch(spec, spec.timeoutMs)
      requestId = started.requestId
      deadlineTimer = setTimeout(() => {
        timedOut = true
        killRemote()
      }, spec.timeoutMs)
      await readExecStream(started.res, (event) => {
        switch (event.kind) {
          case 'stream':
            if (event.channel === 'stdout') stdout.push(event.data)
            else stderr.push(event.data)
            return
          case 'exit':
            code = event.code
            sig = event.signal
            sawTerminal = true
            return
          case 'request-error':
            throw new Error(`remote shell error: ${event.message}`)
        }
      })
      if (!sawTerminal) {
        code = null
        sig = null
      }
      if (!aborted && !timedOut && sig === 'SIGKILL' && Date.now() - startedAt >= spec.timeoutMs) {
        timedOut = true
      }
      if (timedOut && !aborted) {
        code = null
        sig = 'SIGKILL'
      }
      return {
        exitCode: code,
        signal: sig,
        timedOut,
        aborted,
        timeoutMs: spec.timeoutMs,
        stdout: stdout.collect(),
        stderr: stderr.collect(),
      }
    } catch (error) {
      if (spec.signal?.aborted === true) {
        aborted = true
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          aborted: true,
          timeoutMs: spec.timeoutMs,
          stdout: stdout.collect(),
          stderr: stderr.collect(),
        }
      }
      throw error
    } finally {
      clearTimeout(deadlineTimer)
      spec.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** A background process backed by an open hub exec stream. */
  private background(spec: ShellExecSpec): ShellProcess {
    let status: ShellProcessStatus = 'running'
    let exitCode: number | null = null
    let signal: NodeJS.Signals | null = null
    let spawnError = ''
    let requestId: string | undefined
    const stdout = new CappedOutput(this.config.maxOutputBytes)
    const stderr = new CappedOutput(this.config.maxOutputBytes)
    let outRead = 0
    let errRead = 0
    let settle!: () => void
    const done = new Promise<void>((resolve) => { settle = resolve })

    const proc: ShellProcess = {
      get status() { return status },
      get exitCode() { return exitCode },
      get signal() { return signal },
      done,
      readOutput: (): ShellProcessRead => {
        const outText = stdout.collect().text
        const errText = stderr.collect().text
        const out = outText.slice(outRead)
        const err = errText.slice(errRead)
        outRead += out.length
        errRead += err.length
        const sep = out.length > 0 && !out.endsWith('\n') ? '\n' : ''
        const mergedErr = err.length > 0 ? `${sep}[stderr]\n${err}` : ''
        const note = out.length === 0 && err.length === 0 ? spawnError : ''
        spawnError = ''
        return { delta: `${out}${mergedErr}${note}`, lossy: false }
      },
      kill: (): boolean => {
        if (status !== 'running') return false
        status = 'killed'
        if (requestId !== undefined) void runKill(this.config.hubUrl, this.config.user, requestId, this.config.agentId).catch(() => {})
        return true
      },
    }

    void (async () => {
      try {
        const started = await this.execFetch(spec, undefined)
        requestId = started.requestId
        await readExecStream(started.res, (event) => {
          switch (event.kind) {
            case 'stream':
              if (event.channel === 'stdout') stdout.push(event.data)
              else stderr.push(event.data)
              return
            case 'exit':
              exitCode = event.code
              signal = event.signal
              status = status === 'running' ? 'completed' : status
              return
            case 'request-error':
              spawnError = `remote shell error: ${event.message}`
              status = 'killed'
              return
          }
        })
        if (status === 'running') {
          status = 'killed'
          spawnError = 'remote channel closed before the process exited'
        }
      } catch (error) {
        if (status === 'running') status = 'killed'
        spawnError = `remote exec failed: ${error instanceof Error ? error.message : String(error)}`
      } finally {
        settle()
      }
    })()

    return proc
  }
}

/** Remote shell Service provider: registers as ctx.shell and delegates to a core. */
export class RemoteShellExecutor extends ShellExecutor {
  readonly core: RemoteShellCore

  constructor(ctx: Context, config: RemoteShellConfig) {
    super(ctx)
    this.core = new RemoteShellCore(config)
  }

  /** The declared sandbox mode — the agent root intent. */
  override get sandboxMode(): SandboxMode {
    return this.core.config.sandboxMode
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    return this.core.resolve(request)
  }

  override run(spec: ShellExecSpec): Promise<ShellRunResult> {
    return this.core.run(spec)
  }

  override start(spec: ShellExecSpec): ShellProcess {
    return this.core.start(spec)
  }
}

export default RemoteShellExecutor
