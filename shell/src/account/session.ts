/** Login sessions in Redis. */

import { randomBytes } from 'node:crypto'
import { Redis } from 'ioredis'

const SESSION_PREFIX = 'dsh-session:'
const SESSION_TTL_SECS = 30 * 24 * 60 * 60

export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSecs = SESSION_TTL_SECS,
  ) {}

  /** Create a session for a user; returns the opaque session id. */
  async create(userId: string): Promise<string> {
    const id = randomBytes(32).toString('base64url')
    await this.redis.set(`${SESSION_PREFIX}${id}`, userId, 'EX', this.ttlSecs)
    return id
  }

  /** Resolve a session id to a user id, or undefined when absent/expired. */
  async lookup(sessionId: string): Promise<string | undefined> {
    const value = await this.redis.get(`${SESSION_PREFIX}${sessionId}`)
    return value === null ? undefined : value
  }

  /** Destroy a session (logout). */
  async destroy(sessionId: string): Promise<void> {
    await this.redis.del(`${SESSION_PREFIX}${sessionId}`)
  }
}
