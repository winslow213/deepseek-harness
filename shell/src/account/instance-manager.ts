/** Account-owned lifecycle for one supervised dsh instance per member. */

import { superviseUserInstance, type SupervisedInstance } from '../spawn-user.ts'
import { launchTokenFromUrl } from '../instance-register.ts'
import type { InstanceStore } from './instances.ts'

export interface InstanceManagerOptions {
  readonly instances: InstanceStore
  readonly portStart: number
  readonly portEnd: number
  /** Idle timeout in seconds after which a member's instance is reclaimed. */
  readonly idleTimeoutSecs: number
}

/** How often the idle scanner sweeps for stale instances, in seconds. */
const IDLE_SWEEP_INTERVAL_SECS = 60

/**
 * Starts a user's supervised shell instance after login and owns its process
 * until account-service shutdown or supervision-loop exit. The instance runs
 * in-process (no `spawn-user` subprocess), so registration writes the store
 * directly instead of the HTTP path the standalone `spawn-user` CLI uses.
 */
export class InstanceManager {
  private readonly managed = new Map<string, SupervisedInstance>()
  private readonly starting = new Map<string, Promise<void>>()
  private readonly reservedPorts = new Set<number>()
  private readonly idleTimer: NodeJS.Timeout

  constructor(private readonly options: InstanceManagerOptions) {
    this.idleTimer = setInterval(() => {
      void this.reapIdle()
    }, IDLE_SWEEP_INTERVAL_SECS * 1000)
    // The account service's HTTP server keeps the process alive; the sweep
    // timer must not, so tests and short-lived boots exit cleanly.
    this.idleTimer.unref()
  }

  /**
   * Reclaim members whose instance has been idle past the configured timeout.
   * The proxy refreshes `last_seen_at` on every route decision, so a live
   * session never crosses the threshold; a member whose browser closed or
   * whose session lapsed is reclaimed on the next sweep and cold-starts on
   * their next login.
   */
  private async reapIdle(): Promise<void> {
    const idleUsers = await this.options.instances.idleUsers(this.options.idleTimeoutSecs)
    await Promise.all(idleUsers.map(userId => this.stop(userId)))
  }

  /** Ensure one registered instance exists for a user. */
  async ensure(userId: string): Promise<void> {
    if (await this.options.instances.routeFor(userId) !== undefined) return
    const existing = this.starting.get(userId)
    if (existing !== undefined) {
      await existing
      return
    }
    const operation = this.start(userId)
    this.starting.set(userId, operation)
    try {
      await operation
    } finally {
      this.starting.delete(userId)
    }
  }

  /**
   * Stop one user's supervised instance and drop its registration. The
   * supervision loop's `exited` settlement already runs the same cleanup
   * (managed map + reserved port + registration), but this awaits the stop
   * and removes the registration deterministically so a logout returns with
   * the instance gone rather than shortly after.
   * @param userId - the account whose instance stops.
   */
  async stop(userId: string): Promise<void> {
    const instance = this.managed.get(userId)
    if (instance === undefined) {
      // No running supervisor (never started, or the loop already ended).
      // Drop any stale registration so the user next logs in to a cold start.
      await this.options.instances.remove(userId)
      return
    }
    this.managed.delete(userId)
    this.reservedPorts.delete(instance.port)
    await instance.stop()
    await this.options.instances.remove(userId)
  }

  private async start(userId: string): Promise<void> {
    const port = await this.allocatePort()
    this.reservedPorts.add(port)
    const instance = superviseUserInstance(userId, port, {
      // Re-register every later generation (an install-triggered restart mints
      // a fresh launch token). The first generation is registered by the
      // deterministic await below; a duplicate upsert is idempotent.
      onReady: (user, p, inst) => {
        void this.register(user, p, inst.child.pid, inst.url).catch(() => {})
      },
    })
    this.managed.set(userId, instance)
    instance.exited.then(() => {
      this.managed.delete(userId)
      this.reservedPorts.delete(port)
      void this.options.instances.remove(userId)
    })
    // Wait for the first generation to announce its URL and register it before
    // returning; `url` rejects if the first generation dies before announcing.
    const url = await instance.url
    await this.register(userId, port, instance.child.pid, url)
  }

  private async register(userId: string, port: number, pid: number | undefined, url: string | Promise<string>): Promise<void> {
    await this.options.instances.upsert(userId, port, launchTokenFromUrl(await url), pid)
  }

  private async allocatePort(): Promise<number> {
    const rows = await this.options.instances.list()
    const used = new Set(rows.map(row => row.port))
    for (let port = this.options.portStart; port <= this.options.portEnd; port += 1) {
      if (!used.has(port) && !this.reservedPorts.has(port)) return port
    }
    throw new Error('no instance port is available')
  }

  /** Stop all account-owned shell supervisors. */
  async stopAll(): Promise<void> {
    clearInterval(this.idleTimer)
    const instances = [...this.managed.values()]
    await Promise.all(instances.map(instance => instance.stop()))
    this.managed.clear()
    this.reservedPorts.clear()
  }
}
