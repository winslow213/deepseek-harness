/**
 * Host execution of A2UI `command` actions. The capability resolves and
 * starts one command through the composed `shell` service (which applies the
 * executor's environment scrub, output caps, process-group kill escalation,
 * and sandbox policy), keeps the `ShellProcess` live handle in a per-service
 * registry, and serves consuming reads and stops to the Remote controller.
 *
 * A command action's template is filled on this side: each `{fieldName}`
 * placeholder is replaced by the collected value as one POSIX single-quoted
 * shell word, so a user-supplied value can never splice into the command's
 * static text as syntax.
 * @module @deepseek-ai/dsh-tool-a2ui-store/run
 */

import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ShellProcess } from '@deepseek-ai/dsh-shell'
import type { A2uiRunFieldValues, A2uiUpdateData } from './types.ts'

/**
 * The owning session a `command`-action run appends its durable `a2ui/update`
 * events to. Kept as a narrow adapter so the runner depends on the two facts it
 * needs — the mounted workspace directory and the append path — rather than the
 * full {@link @deepseek-ai/dsh-session!Session} service.
 */
export interface A2uiRunSession {
  /** Absolute working directory the session was created in (the mounted workspace). */
  readonly cwd?: string
  /** Append one durable live-result event to the session log. */
  append(type: 'a2ui/update', data: A2uiUpdateData): unknown
}

/** What one `command`-action run needs to start: the command plus its correlation and session. */
export interface A2uiRunStart {
  /** The `{fieldName}` command template to fill and execute. */
  readonly command: string
  /** Collected field values the template substitutes. */
  readonly fields: A2uiRunFieldValues
  /** Run bound in milliseconds; absent uses the host shell default and cap. */
  readonly timeoutMs?: number
  /** Owning session: supplies the workdir and receives the `a2ui/update` events. */
  readonly session: A2uiRunSession
  /** Stable surface identity the live-result events correlate with. */
  readonly surfaceId: string
}

/** One live or settled command run served by the capability. */
export interface A2uiRunHandle {
  /** Opaque run identity minted by the capability. */
  readonly runId: string
  /** The started shell process. */
  readonly proc: ShellProcess
  /** The running command (for diagnostics). */
  readonly command: string
  /** Monotonic chunk sequence: each consumed read advances it. */
  seq: number
  /** Cumulative byte count of the emitted stream, for throughput labels. */
  totalBytes: number
  /** Owning session the run's `a2ui/update` events append to. */
  readonly session: A2uiRunSession
  /** Stable surface identity the live-result events carry. */
  readonly surfaceId: string
  /** True once a settle event (`finished`/`aborted`) has been appended. */
  settled: boolean
}

/** Host capability backing `ctx.a2uiRun`. */
export interface A2uiRun {
  /**
   * Fill a `{field}`-template command with single-quoted field values, start
   * it in the composed shell service with the session's workspace as workdir,
   * and append the run's `a2ui/update` `started` event to the session.
   * @param request - the command, its correlation and session, and optional bound.
   * @returns the live run handle.
   * @throws when the shell service is absent or the template is invalid.
   */
  start(request: A2uiRunStart): A2uiRunHandle
  /**
   * The handle for one run id.
   * @param runId - the opaque run identity minted by the capability.
   * @returns the live or settled run handle.
   * @throws when the run id is unknown.
   */
  get(runId: string): A2uiRunHandle
  /**
   * Read the output produced since the previous read, consuming it. Each read
   * appends the matching `a2ui/update` event (a `delta` when output arrived, a
   * `finished`/`aborted` settle when the process left `running`).
   * @param runId - the opaque run identity minted by the capability.
   * @returns the monotonic chunk sequence, the new output, and live state.
   */
  read(runId: string): { seq: number; output: string; running: boolean; exitCode: number | null; lossy: boolean }
  /**
   * Kill the run's process group and append the `a2ui/update` `aborted` event.
   * @param runId - the opaque run identity minted by the capability.
   * @returns false when the run had already finished, true otherwise.
   */
  stop(runId: string): boolean
}

/** Wrap one value as a POSIX single-quoted shell word. */
function shellQuote(value: string | number | boolean | null): string {
  const text = value === null ? '' : String(value)
  // A single quote cannot appear inside a single-quoted word; splice with
  // '\'' per the POSIX concatenation rule.
  return `'${text.replaceAll("'", "'\\''")}'`
}

/**
 * Fill `{name}` placeholders in a command template. A placeholder names a
 * field; a name with no field value (null) becomes the empty word. Every
 * placeholder must name a provided field — an unknown one fails loud instead
 * of running a partially substituted command.
 * @param command - the raw command template.
 * @param fields - the values to substitute.
 * @returns the filled command.
 * @throws naming the offending placeholder when one is unknown.
 */
export function fillA2uiCommand(command: string, fields: A2uiRunFieldValues): string {
  return command.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    if (!(name in fields)) {
      throw new Error(`a2ui command action: placeholder {${name}} has no matching field`)
    }
    return shellQuote(fields[name] ?? null)
  })
}

/** Count UTF-8 bytes of one delta for the cumulative throughput label. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * The shell-service-backed run capability registered on `ctx.a2uiRun`. The
 * shell service is resolved lazily so the plugin mounts in compositions that
 * carry no shell executor; only an actual command run needs one.
 */
export class ShellA2uiRun implements A2uiRun {
  private readonly runs = new Map<string, A2uiRunHandle>()

  /** @param ctx - registrant context that may acquire the shell service. */
  constructor(private readonly ctx: Context) {}

  start(request: A2uiRunStart): A2uiRunHandle {
    const shell = this.ctx.get('shell')
    if (shell === undefined) {
      throw new Error('a2uiRun: no shell service is mounted; a `command` action cannot run')
    }
    const filled = fillA2uiCommand(request.command, request.fields)
    const spec = shell.resolve({
      command: filled,
      // The command runs in the session's mounted workspace, matching the
      // foreground bash tool's default; absent cwd leaves the executor default.
      ...request.session.cwd === undefined ? {} : { workdir: request.session.cwd },
      ...request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs },
      // One full-screen-worth budget beats truncating a tool's primary output;
      // a runaway tail still spills to a file rather than growing memory.
      stdoutMaxBytes: 64 * 1024 * 1024,
    })
    const proc = shell.start(spec)
    const runId = `a2ui-run-${randomBytes(6).toString('hex')}`
    const handle: A2uiRunHandle = {
      runId, proc, command: filled, seq: 0, totalBytes: 0,
      session: request.session, surfaceId: request.surfaceId, settled: false,
    }
    this.runs.set(runId, handle)
    request.session.append('a2ui/update', { surfaceId: request.surfaceId, phase: 'started', seq: 0, totalBytes: 0 })
    return handle
  }

  get(runId: string): A2uiRunHandle {
    const handle = this.runs.get(runId)
    if (handle === undefined) throw new Error(`a2uiRun: unknown run "${runId}"`)
    return handle
  }

  read(runId: string): { seq: number; output: string; running: boolean; exitCode: number | null; lossy: boolean } {
    const handle = this.get(runId)
    const chunk = handle.proc.readOutput()
    handle.seq += 1
    handle.totalBytes += byteLength(chunk.delta)
    const running = handle.proc.status === 'running'
    if (chunk.delta.length > 0) {
      handle.session.append('a2ui/update', {
        surfaceId: handle.surfaceId, phase: 'delta', seq: handle.seq, delta: chunk.delta, totalBytes: handle.totalBytes,
      })
    }
    if (!running && !handle.settled) {
      handle.settled = true
      handle.session.append('a2ui/update', {
        surfaceId: handle.surfaceId,
        phase: handle.proc.status === 'killed' ? 'aborted' : 'finished',
        seq: handle.seq,
        totalBytes: handle.totalBytes,
      })
    }
    return {
      seq: handle.seq,
      output: chunk.delta,
      running,
      exitCode: handle.proc.exitCode,
      lossy: chunk.lossy,
    }
  }

  stop(runId: string): boolean {
    const handle = this.get(runId)
    const requested = handle.proc.kill()
    if (requested && !handle.settled) {
      handle.settled = true
      handle.session.append('a2ui/update', { surfaceId: handle.surfaceId, phase: 'aborted', seq: handle.seq, totalBytes: handle.totalBytes })
    }
    return requested
  }
}
