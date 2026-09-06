/** Account-owned lifecycle for one supervised dsh instance per member. */

import { superviseUserInstance, type SupervisedInstance } from '../spawn-user.ts'
import { launchTokenFromUrl } from '../instance-register.ts'
import type { InstanceStore } from './instances.ts'

export interface InstanceManagerOptions {
  readonly instances: InstanceStore
  readonly portStart: number
  readonly portEnd: number
}

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

  constructor(private readonly options: InstanceManagerOptions) {}

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
    const instances = [...this.managed.values()]
    await Promise.all(instances.map(instance => instance.stop()))
    this.managed.clear()
    this.reservedPorts.clear()
  }
}
