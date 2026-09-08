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
import type { A2uiRunFieldValues } from './types.ts'

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
}

/** Host capability backing `ctx.a2uiRun`. */
export interface A2uiRun {
  /**
   * Fill a `{field}`-template command with single-quoted field values and
   * start it in the background through the composed shell service.
   * @param command - the model-authored command template.
   * @param fields - collected field values the template references.
   * @param timeoutMs - run bound; absent uses the shell default and cap.
   * @returns the live run handle.
   * @throws when the shell service is absent or the template is invalid.
   */
  start(command: string, fields: A2uiRunFieldValues, timeoutMs?: number): A2uiRunHandle
  /** The handle for one run id; throws when unknown. */
  get(runId: string): A2uiRunHandle
  /** Read the output produced since the previous read (consuming). */
  read(runId: string): { seq: number; output: string; running: boolean; exitCode: number | null; lossy: boolean }
  /** Kill the run's process group; false when it had already finished. */
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

/**
 * The shell-service-backed run capability registered on `ctx.a2uiRun`. The
 * shell service is resolved lazily so the plugin mounts in compositions that
 * carry no shell executor; only an actual command run needs one.
 */
export class ShellA2uiRun implements A2uiRun {
  private readonly runs = new Map<string, A2uiRunHandle>()

  /** @param ctx - registrant context that may acquire the shell service. */
  constructor(private readonly ctx: Context) {}

  start(command: string, fields: A2uiRunFieldValues, timeoutMs?: number): A2uiRunHandle {
    const shell = this.ctx.get('shell')
    if (shell === undefined) {
      throw new Error('a2uiRun: no shell service is mounted; a `command` action cannot run')
    }
    const filled = fillA2uiCommand(command, fields)
    const spec = shell.resolve({
      command: filled,
      ...timeoutMs === undefined ? {} : { timeoutMs },
      // One full-screen-worth budget beats truncating a tool's primary output;
      // a runaway tail still spills to a file rather than growing memory.
      stdoutMaxBytes: 64 * 1024 * 1024,
    })
    const proc = shell.start(spec)
    const runId = `a2ui-run-${randomBytes(6).toString('hex')}`
    const handle: A2uiRunHandle = { runId, proc, command: filled, seq: 0 }
    this.runs.set(runId, handle)
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
    return {
      seq: handle.seq,
      output: chunk.delta,
      running: handle.proc.exitCode === null,
      exitCode: handle.proc.exitCode,
      lossy: chunk.lossy,
    }
  }

  stop(runId: string): boolean {
    return this.get(runId).proc.kill()
  }
}
