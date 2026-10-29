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
import { listMounts } from './client.ts'
import type { MountRecord } from './hub.ts'
import { openRemoteTerminal } from './pty-client.ts'
import { translateShadowPath } from './shadow.ts'

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
  private mountsCache: readonly MountRecord[] | undefined

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
    void this.refreshMounts()
  }

  /** Pull the mount table this router translates shadow paths against. */
  private async refreshMounts(): Promise<void> {
    try {
      this.mountsCache = await listMounts(this.hubUrl)
    } catch {
      this.mountsCache = []
    }
  }

  /**
   * Resolve the device's real working directory for one shadow path.
   *
   * The agent validates `cwd` against the roots it actually serves, so a shadow
   * path cannot be forwarded as-is: it would name a server directory the device
   * never had. The mount table is the only thing that maps one to the other, and
   * it is pulled fire-and-forget, so a path that misses the cache refreshes once
   * before the allocation is refused — a terminal opened right after pairing
   * would otherwise run against the empty shadow stub.
   * @param cwd - the Session's working directory, already known to sit under the shadow root.
   * @returns the device path to allocate in, or undefined when no mount of this user covers it.
   */
  private async deviceCwdFor(cwd: string): Promise<string | undefined> {
    const translation = (mounts: readonly MountRecord[] | undefined): string | undefined => {
      const hit = translateShadowPath(cwd, mounts ?? [])
      // A shadow path belonging to another account's mount is not this router's
      // to serve; falling through to local would run the device's directory on
      // the server, so it is refused instead.
      return hit === undefined || hit.user !== this.user ? undefined : hit.remotePath
    }
    const cached = translation(this.mountsCache)
    if (cached !== undefined) return cached
    await this.refreshMounts()
    return translation(this.mountsCache)
  }

  /** @inheritdoc */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (!isAbsolute(spec.cwd) || !isUnder(resolve(spec.cwd), this.shadowRoot)) return super.spawnTerminal(spec)
    spec.signal?.throwIfAborted()
    const cwd = await this.deviceCwdFor(spec.cwd)
    if (cwd === undefined) throw new Error(`region-subprocess: no paired device serves ${spec.cwd}`)
    return openRemoteTerminal(
      { hubUrl: this.hubUrl, user: this.user, agentId: this.agentId },
      {
        argv: spec.argv, cwd, cols: spec.cols, rows: spec.rows,
        terminalType: spec.terminalType, env: spec.env, signal: spec.signal,
      },
    )
  }
}

/** Plugin display name for loader diagnostics. */
export const name = 'region-subprocess'

export default RegionRouterSubprocessRuntime
