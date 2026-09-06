/**
 * Region-router shell executor: ONE ctx.shell that runs commands locally when
 * the workdir is a normal server path, and relays them to the owning agent
 * when the workdir is inside a mounted root's shadow tree (design.md §7.9).
 *
 * This provider EXTENDS the sandboxed local bash executor, so local commands
 * inherit the full local + sandbox semantics. Shadow workdirs are rewritten to
 * the agent's real path and handed to a registration-free {@link RemoteShellCore}.
 * Loading it as a loader row needs no delegate assembly — it registers as
 * ctx.shell exactly as bash-sandbox did, and the loader waits on the inherited
 * subprocess/sandbox/sandboxPolicy inject as it did for bash-sandbox.
 *
 * @module dsh-team-shell/region-shell
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import type { Config as BashLocalConfig } from '@deepseek-ai/dsh-bash-local'
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import { RemoteShellCore } from './executor.ts'
import { translateShadowPath } from './shadow.ts'
import type { MountRecord } from './hub.ts'
import { listMounts } from './client.ts'

/** The local bash config plus the region-router's own knobs. */
export interface Config extends BashLocalConfig {
  /** Hub control API base the router forwards mounted commands to. */
  hubUrl: string
  /** Root holding every mount's shadow directory. */
  shadowRoot: string
  /** Hub user id of this instance; only that user's mounts are remote-run. */
  user: string
}

/**
 * One ctx.shell: local server commands through the inherited sandboxed local
 * executor, mounted shadow-tree workdirs through the owning remote agent.
 */
export class RegionRouterShellExecutor extends SandboxBashExecutor {
  /** Per-agent remote runners, keyed by hub agent id ('' for the default core). */
  private readonly remotes = new Map<string, RemoteShellCore>()
  private readonly remoteBase: {
    hubUrl: string
    user: string
    timeoutMs: number | undefined
    maxTimeoutMs: number | undefined
    maxOutputBytes: number | undefined
  }
  private readonly shadowRoot: string
  private readonly user: string
  private mountsCache: readonly MountRecord[] | undefined

  constructor(ctx: never, config: Config) {
    super(ctx, config)
    if (typeof config.hubUrl !== 'string' || config.hubUrl === '') throw new Error('region-shell: hubUrl is required')
    if (typeof config.shadowRoot !== 'string' || config.shadowRoot === '') throw new Error('region-shell: shadowRoot is required')
    if (typeof config.user !== 'string' || config.user === '') throw new Error('region-shell: user is required')
    this.shadowRoot = config.shadowRoot.replace(/\/+$/, '')
    this.user = config.user
    this.remoteBase = {
      hubUrl: config.hubUrl,
      user: config.user,
      timeoutMs: config.timeoutMs,
      maxTimeoutMs: config.maxTimeoutMs,
      maxOutputBytes: config.maxOutputBytes,
    }
    void this.refreshMounts()
  }

  /** The remote runner for one agent id (or the default when absent). */
  private coreFor(agentId?: string): RemoteShellCore {
    const key = agentId ?? ''
    const existing = this.remotes.get(key)
    if (existing !== undefined) return existing
    const core = new RemoteShellCore({
      hubUrl: this.remoteBase.hubUrl,
      user: this.remoteBase.user,
      ...agentId === undefined ? {} : { agentId },
      cwd: this.shadowRoot,
      timeoutMs: this.remoteBase.timeoutMs,
      maxTimeoutMs: this.remoteBase.maxTimeoutMs,
      maxOutputBytes: this.remoteBase.maxOutputBytes,
      sandboxMode: 'workspace-write',
    })
    this.remotes.set(key, core)
    return core
  }

  /** The inherited local sandbox mode — the capability fact tool layers read. */
  override get sandboxMode(): SandboxMode {
    return super.sandboxMode
  }

  private async refreshMounts(): Promise<void> {
    try {
      this.mountsCache = await listMounts(this.remoteBase.hubUrl)
    } catch {
      this.mountsCache = []
    }
  }

  private isShadow(path: string): boolean {
    return path === this.shadowRoot || path.startsWith(this.shadowRoot + '/')
  }

  /** True when a shadow path maps to one of this user's online mounts. */
  private coversShadow(path: string): boolean {
    const t = translateShadowPath(path, this.mountsCache ?? [])
    return t !== undefined && t.user === this.user
  }

  /**
   * Ensure the mount cache is warm for a shadow workdir before dispatch. The
   * cache is pulled fire-and-forget on construction and resolve, so a command
   * that arrives before the pull settles (or before a freshly paired agent
   * registered) would otherwise fall back to local execution on the empty
   * shadow stub.
   */
  private async refreshFor(path: string | undefined): Promise<void> {
    if (path === undefined || !this.isShadow(path) || this.coversShadow(path)) return
    await this.refreshMounts()
  }

  /** Rewrite a shadow workdir into the agent's real path, when it is our mount. */
  private remoteSpec(spec: ShellExecSpec): { spec: ShellExecSpec; agentId: string } | undefined {
    if (spec.workdir === undefined || !this.isShadow(spec.workdir)) return undefined
    const t = translateShadowPath(spec.workdir, this.mountsCache ?? [])
    if (t === undefined || t.user !== this.user) return undefined
    return { spec: { ...spec, workdir: t.remotePath }, agentId: t.mount.agentId }
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    void this.refreshMounts()
    return super.resolve(request)
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    await this.refreshFor(spec.workdir)
    const remote = this.remoteSpec(spec)
    if (remote === undefined) return super.run(spec)
    return this.coreFor(remote.agentId).run(remote.spec)
  }

  override start(spec: ShellExecSpec): ShellProcess {
    const remote = this.remoteSpec(spec)
    if (remote === undefined) return super.start(spec)
    return this.coreFor(remote.agentId).start(remote.spec)
  }
}

export default RegionRouterShellExecutor
