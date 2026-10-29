/**
 * Region subprocess provider: ONE `ctx.subprocess` that keeps local processes
 * local and runs a browser terminal on the paired device when its working
 * directory is a mounted root's shadow path.
 *
 * It EXTENDS the local provider rather than replacing it, so `exec`, piped
 * `spawn`, executable lookup and shell-environment inspection keep their full
 * local + sandbox semantics — only terminal allocation is routed. That split is
 * deliberate and temporary: a Session's mounted files still search the shadow
 * copy (the gap recorded in `shell/design.md` §13.6), while its terminal is the
 * member's own shell.
 *
 * Routing keys on `spec.cwd`, the one execution-world argument the terminal
 * seam carries. Shell discovery is not routed because `terminalEnvironment()`
 * and `resolveExecutable()` take no directory, so the Host names the shell and
 * the device runs it; a device without that exact executable path fails the
 * allocation instead of silently running a different shell.
 *
 * @module dsh-team-shell/region-subprocess
 */

import { isAbsolute, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { openRemoteTerminal } from './pty-client.ts'

/** The local provider's config plus this router's own knobs. */
export interface Config {
  /** Hub control API base the router forwards terminal allocation to. */
  hubUrl: string
  /** Root holding every mount's shadow directory. */
  shadowRoot: string
  /** User whose paired device serves the terminal; the hub addresses agents by owner. */
  user: string
  /** Specific agent id to address; omitted lets the hub pick the user's online agent. */
  agentId?: string
}

/** Whether a path is the root itself or a descendant of it, compared on segments. */
function isUnder(path: string, root: string): boolean {
  const base = root.endsWith(sep) ? root.slice(0, -1) : root
  return path === base || path.startsWith(`${base}${sep}`)
}

/**
 * One `ctx.subprocess` whose terminal allocation follows the Session's
 * execution world.
 */
export class RegionRouterSubprocessRuntime extends LocalSubprocessRuntime {
  private readonly hubUrl: string
  private readonly shadowRoot: string
  private readonly user: string
  private readonly agentId: string | undefined

  /**
   * @param ctx - plugin context this service registers on.
   * @param config - hub endpoint and the shadow root that marks a mounted workspace.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (typeof config.hubUrl !== 'string' || config.hubUrl === '') throw new Error('region-subprocess: hubUrl is required')
    if (typeof config.shadowRoot !== 'string' || config.shadowRoot === '') throw new Error('region-subprocess: shadowRoot is required')
    if (typeof config.user !== 'string' || config.user === '') throw new Error('region-subprocess: user is required')
    this.hubUrl = config.hubUrl.replace(/\/+$/, '')
    this.shadowRoot = resolve(config.shadowRoot)
    this.user = config.user
    this.agentId = config.agentId
  }

  /** @inheritdoc */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (!isAbsolute(spec.cwd) || !isUnder(resolve(spec.cwd), this.shadowRoot)) return super.spawnTerminal(spec)
    spec.signal?.throwIfAborted()
    return openRemoteTerminal(
      { hubUrl: this.hubUrl, user: this.user, agentId: this.agentId },
      {
        argv: spec.argv, cwd: spec.cwd, cols: spec.cols, rows: spec.rows,
        terminalType: spec.terminalType, env: spec.env, signal: spec.signal,
      },
    )
  }
}

/** Plugin display name for loader diagnostics. */
export const name = 'region-subprocess'

export default RegionRouterSubprocessRuntime
