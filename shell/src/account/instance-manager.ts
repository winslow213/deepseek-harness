/** Account-owned lifecycle for one supervised dsh instance per member. */

import { superviseUserInstance, listBotConnectedUsers, type SupervisedInstance } from '../spawn-user.ts'
import { launchTokenFromUrl } from '../instance-register.ts'
import type { InstanceStore } from './instances.ts'
import type { UserStore } from './users.ts'

export interface InstanceManagerOptions {
  readonly instances: InstanceStore
  readonly users: UserStore
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
      void this.sweep()
    }, IDLE_SWEEP_INTERVAL_SECS * 1000)
    // The account service's HTTP server keeps the process alive; the sweep
    // timer must not, so tests and short-lived boots exit cleanly.
    this.idleTimer.unref()
  }

  /**
   * Run one idle-and-keep-alive pass.
   *
   * Both halves read one snapshot of the keep-alive set, and reaping skips it.
   * An account that must stay up but is not `idle_exempt` — a bot-connected
   * account whose owner never marked it — would otherwise be reclaimed on the
   * idle timeout and restarted immediately, dropping its bot connection on
   * every cycle. Reading the set once keeps the two halves from disagreeing
   * about the same account within a pass.
   *
   * Public so the policy is exercisable without waiting on the 60-second timer.
   */
  async sweep(): Promise<void> {
    const keepAlive = await this.keptAliveUsers()
    if (keepAlive === undefined) return
    await this.reapIdle(keepAlive)
    await this.startMissing(keepAlive)
  }

  /**
   * The accounts that must stay up, or `undefined` when the set cannot be
   * read. An unreadable set must not be treated as empty: reaping without it
   * would reclaim exactly the accounts this pass exists to protect.
   */
  private async keptAliveUsers(): Promise<Set<string> | undefined> {
    try {
      return await this.accountsToKeepAlive()
    } catch (error) {
      console.error('[team-account] could not list kept-alive accounts', error)
      return undefined
    }
  }

  /**
   * Reclaim members whose instance has been idle past the configured timeout.
   * The proxy refreshes `last_seen_at` on every route decision, so a live
   * session never crosses the threshold; a member whose browser closed or
   * whose session lapsed is reclaimed on the next sweep and cold-starts on
   * their next login.
   */
  private async reapIdle(keepAlive: ReadonlySet<string>): Promise<void> {
    const idleUsers = await this.options.instances.idleUsers(this.options.idleTimeoutSecs)
    await Promise.all(idleUsers.filter(userId => !keepAlive.has(userId)).map(userId => this.stop(userId)))
  }

  /**
   * Accounts that must have a live instance, as the union of two independent
   * reasons to stay up.
   *
   * `idle_exempt` is the operator's standing instruction that the account is
   * meant to stay running. A bound IM bot is a second reason the operator
   * never has to restate: the bot reaches its agent only through this
   * instance, so an instance that is gone is a bot that silently stopped
   * answering — and because instances start only on login, nothing would
   * bring it back. Taking the union means neither reason has to be duplicated
   * into the other's bookkeeping.
   * @returns the distinct account ids that must be running.
   */
  private async accountsToKeepAlive(): Promise<Set<string>> {
    const exempt = await this.options.users.listIdleExemptUserIds()
    return new Set([...exempt, ...listBotConnectedUsers()])
  }

  /**
   * Start an instance for every account that must stay up and is not running.
   *
   * This is what makes "kept alive" hold continuously rather than only from
   * the next service start, and it is also what a restart relies on to bring
   * those accounts back — every instance dies with its parent account service,
   * so a stop-and-start otherwise leaves the whole set cold until someone
   * happens to log in.
   *
   * A running account is skipped before `ensure` is consulted, so the common
   * case is one store lookup per account per sweep and no log traffic. A
   * started one is named in the log: an instance that had to be restarted is
   * the event worth seeing, and it is otherwise invisible.
   *
   * Every account is isolated — one failing to start must not stop the rest.
   */
  async keepAlive(): Promise<void> {
    const keepAlive = await this.keptAliveUsers()
    if (keepAlive !== undefined) await this.startMissing(keepAlive)
  }

  /** Start an instance for each of `userIds` that is not already running. */
  private async startMissing(userIds: ReadonlySet<string>): Promise<void> {
    for (const userId of userIds) {
      try {
        if (await this.options.instances.routeFor(userId) !== undefined) continue
        await this.ensure(userId)
        console.log(`[team-account] started instance for ${userId} (kept alive)`)
      } catch (error) {
        console.error(`[team-account] failed to keep instance alive for ${userId}`, error)
      }
    }
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
