/**
 * Region subprocess provider: ONE `ctx.subprocess` that keeps local processes
 * local and runs a browser terminal on the paired device when its working
 * directory is a mounted root's shadow path.
 *
 * It EXTENDS the local provider rather than replacing it, so `exec`, piped
 * `spawn` and the rest of the process surface keep their full local + sandbox
 * semantics. That split is deliberate and temporary: a Session's mounted files
 * still search the shadow copy (the gap recorded in `shell/design.md` §13.6),
 * while its terminal is the member's own shell.
 *
 * Routing keys on `cwd`, the execution-world argument every routed call
 * carries: `spawnTerminal` takes it in the spec, and `terminalEnvironment()` /
 * `resolveExecutable()` take it as an optional argument for exactly this
 * reason. Answering shell discovery locally would name the Host's own
 * executable — a path the device does not have, so a Windows member paired to
 * a Linux Host could never open a terminal. The device instead answers for its
 * own platform and default shell, and a bare shell name travels unresolved so
 * the device resolves it in its own PATH.
 *
 * @module dsh-team-shell/region-subprocess
 */

import { isAbsolute, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { listAgents, listMounts } from './client.ts'
import type { AgentRecord, MountRecord } from './hub.ts'
import { openRemoteTerminal } from './pty-client.ts'
import type { ShadowTranslation } from './shadow.ts'
import { translateShadowPath } from './shadow.ts'

/** The local provider's config plus this router's own knobs. */
export interface Config {
  /** Hub control API base the router forwards terminal allocation to. */
  hubUrl: string
  /** Root holding every mount's shadow directory. */
  shadowRoot: string
  /** User whose paired device serves the terminal; the hub addresses agents by owner. */
  user: string
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
  private mountsCache: readonly MountRecord[] | undefined
  private agentsCache: readonly AgentRecord[] | undefined

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

  /** Pull the agents that advertise which shell world each mount serves. */
  private async refreshAgents(): Promise<void> {
    try {
      this.agentsCache = await listAgents(this.hubUrl)
    } catch {
      this.agentsCache = []
    }
  }

  /**
   * Resolve the mount serving one shadow path.
   *
   * The agent validates `cwd` against the roots it actually serves, so a shadow
   * path cannot be forwarded as-is: it would name a server directory the device
   * never had. The mount table is the only thing that maps one to the other, and
   * it is pulled fire-and-forget, so a path that misses the cache refreshes once
   * before the allocation is refused — a terminal opened right after pairing
   * would otherwise run against the empty shadow stub.
   *
   * The hit names the agent too, which the allocation must carry: one user may
   * pair several devices, and the hub refuses to pick between the ones online.
   * @param cwd - the Session's working directory, already known to sit under the shadow root.
   * @returns the matching mount translation, or undefined when no mount of this user covers it.
   */
  private async shadowTranslationFor(cwd: string): Promise<ShadowTranslation | undefined> {
    const translation = (mounts: readonly MountRecord[] | undefined): ShadowTranslation | undefined => {
      const hit = translateShadowPath(cwd, mounts ?? [])
      // A shadow path belonging to another account's mount is not this router's
      // to serve; falling through to local would run the device's directory on
      // the server, so it is refused instead.
      return hit === undefined || hit.user !== this.user ? undefined : hit
    }
    const cached = translation(this.mountsCache)
    if (cached !== undefined) return cached
    await this.refreshMounts()
    return translation(this.mountsCache)
  }

  /**
   * The terminal facts one agent advertises about its own host.
   *
   * The inherited local provider answers shell discovery for the server host,
   * which names an executable the device may not have. The agent's `hello`
   * carries both facts, so the router can answer for the device instead.
   * @param agentId - the agent registered for the mount under the Session's working directory.
   * @returns platform and default shell that agent reported; both absent when it reported neither.
   */
  private async terminalWorldFor(agentId: string): Promise<{ platform?: 'posix' | 'windows'; defaultShell?: string }> {
    const find = (agents: readonly AgentRecord[] | undefined): AgentRecord | undefined =>
      (agents ?? []).find(agent => agent.agentId === agentId)
    let hit = find(this.agentsCache)
    if (hit === undefined) {
      await this.refreshAgents()
      hit = find(this.agentsCache)
    }
    if (hit === undefined) return {}
    return {
      ...hit.platform === undefined ? {} : { platform: hit.platform },
      ...hit.defaultShell === undefined ? {} : { defaultShell: hit.defaultShell },
    }
  }

  /**
   * The agent serving one working directory.
   * @param cwd - a Session working directory, or undefined when the caller has none.
   * @returns the agent id for a mount of this user, or undefined otherwise.
   */
  private async agentFor(cwd: string | undefined): Promise<string | undefined> {
    if (cwd === undefined || !isAbsolute(cwd) || !isUnder(resolve(cwd), this.shadowRoot)) return undefined
    const hit = await this.shadowTranslationFor(cwd)
    return hit?.mount.agentId
  }

  /**
   * Answer terminal-environment questions from the device that will run them.
   *
   * A device whose platform and default shell differ from the server's would
   * otherwise be handed the server's own default shell path, which does not
   * exist there. Outside a mount the local answer stands, because that
   * terminal is allocated locally.
   * @param signal - cancellation of the environment inspection.
   * @param cwd - working directory whose mount names the device.
   * @returns the platform and default shell of the device serving `cwd`.
   */
  override async terminalEnvironment(signal?: AbortSignal, cwd?: string): Promise<SubprocessTerminalEnvironment> {
    signal?.throwIfAborted()
    const agentId = await this.agentFor(cwd)
    if (agentId === undefined) return super.terminalEnvironment(signal)
    const world = await this.terminalWorldFor(agentId)
    // An agent built before the hello carried these facts reports neither; the
    // local answer at least keeps the name a bare shell rather than a path.
    if (world.platform === undefined) return super.terminalEnvironment(signal)
    return { platform: world.platform, ...world.defaultShell === undefined ? {} : { defaultShell: world.defaultShell } }
  }

  /**
   * Resolve a shell name on the device rather than on the server.
   *
   * The local provider resolves a bare name against the server's PATH, which
   * yields a server path the device cannot run. Forwarding the name unchanged
   * is what lets the device resolve it in its own PATH; the agent's command
   * allowlist still decides whether that name may run at all.
   * @param command - the executable name or path shell discovery asked about.
   * @param env - extra environment entries layered over the provider's own.
   * @param signal - cancellation of the lookup.
   * @param cwd - working directory whose mount names the device.
   * @returns the name unchanged when a device serves `cwd`, else the local resolution.
   */
  override async resolveExecutable(
    command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal, cwd?: string,
  ): Promise<string> {
    signal?.throwIfAborted()
    if (await this.agentFor(cwd) === undefined) return super.resolveExecutable(command, env, signal)
    return command
  }

  /** @inheritdoc */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (!isAbsolute(spec.cwd) || !isUnder(resolve(spec.cwd), this.shadowRoot)) return super.spawnTerminal(spec)
    spec.signal?.throwIfAborted()
    const hit = await this.shadowTranslationFor(spec.cwd)
    if (hit === undefined) throw new Error(`region-subprocess: no paired device serves ${spec.cwd}`)
    return openRemoteTerminal(
      { hubUrl: this.hubUrl, user: this.user, agentId: hit.mount.agentId },
      {
        argv: spec.argv, cwd: hit.remotePath, cols: spec.cols, rows: spec.rows,
        terminalType: spec.terminalType, env: spec.env, signal: spec.signal,
      },
    )
  }
}

/** Plugin display name for loader diagnostics. */
export const name = 'region-subprocess'

export default RegionRouterSubprocessRuntime
