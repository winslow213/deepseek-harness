/** One-time-per-TTL pairing codes in Redis (shared with the hub claim path). */

import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'

const PAIRING_PREFIX = 'dsh-pairing:'

/** A minted pairing code awaiting agent claims. */
export interface PendingPairing {
  /** The user any agent claiming this code is bound to. */
  readonly user: string
  /** Epoch milliseconds after which the code stops accepting claims. */
  readonly expiresAt: number
}

/**
 * A pairing code is multi-use within its TTL: it accepts any number of agent
 * claims until it expires, so one minted code can mount several devices. The
 * claim path never deletes the key; Redis `PX` expiry retires it.
 */
export class PairingStore {
  constructor(
    private readonly redis: Redis,
    /** Default code lifetime in milliseconds. */
    private readonly ttlMs = 30 * 60 * 1000,
  ) {}

  /** Mint a code for a user; returns the code plus its lifetime. */
  async mint(userId: string): Promise<{ uuid: string; user: string; expiresAt: number; ttlMs: number }> {
    const uuid = randomUUID()
    const expiresAt = Date.now() + this.ttlMs
    const record: PendingPairing = { user: userId, expiresAt }
    await this.redis.set(`${PAIRING_PREFIX}${uuid}`, JSON.stringify(record), 'PX', this.ttlMs)
    return { uuid, user: userId, expiresAt, ttlMs: this.ttlMs }
  }

  /** Resolve a code to its user, or undefined when absent/expired. Does not consume. */
  async lookup(uuid: string): Promise<string | undefined> {
    const raw = await this.redis.get(`${PAIRING_PREFIX}${uuid}`)
    if (raw === null) return undefined
    try {
      const record = JSON.parse(raw) as Partial<PendingPairing>
      if (typeof record.user !== 'string' || typeof record.expiresAt !== 'number') return undefined
      if (Date.now() > record.expiresAt) return undefined
      return record.user
    } catch {
      return undefined
    }
  }
}
