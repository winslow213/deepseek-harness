/**
 * Member-to-member message channel. Redis is the transport: a message waits
 * in per-user lists and is destroyed when its owner fetches, so the
 * send/receive hot path never touches Postgres. Postgres is only the archive
 * — a drained message is recorded there once (deduplicated by message id),
 * and every inbox view is a read over that archive.
 *
 * Every send lands on two lists: the recipient's inbox (`dsh-msg:inbox:<u>`,
 * drained by the recipient's fetch, which marks the message read) and the
 * sender's sent log (`dsh-msg:sent:<u>`, drained by the sender's own fetch,
 * which archives what they sent without waiting for the recipient). Either
 * drain records the row; the other only fills in the missing read stamp.
 *
 * @module dsh-team-shell/account/messages
 */

import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { Queryable } from './db.ts'

/** Per-recipient inbox list key prefix. */
const INBOX_PREFIX = 'dsh-msg:inbox:'
/** Per-sender sent-log list key prefix. */
const SENT_PREFIX = 'dsh-msg:sent:'
/** Per-user send-rate counter key prefix. */
const RATE_PREFIX = 'dsh-msg:rl:'

/** Sends one user may make per minute. */
const SENDS_PER_MINUTE = 60

/** Longest accepted message body, in characters. */
const MAX_BODY_CHARS = 65536

/** How long an unconsumed channel entry may wait before Redis retires it. */
const RETENTION_SECS = 90 * 24 * 60 * 60

/**
 * Drain one channel list atomically: return every queued item and delete the
 * key in the same script execution, so overlapping fetches neither lose a
 * message between read and delete nor deliver one twice.
 */
const DRAIN_LUA = `
local items = redis.call('LRANGE', KEYS[1], 0, -1)
redis.call('DEL', KEYS[1])
return items
`

/**
 * Strictly increasing send timestamps. One account service process writes
 * every send, so this keeps send order == timestamp order even for sends
 * that share a wall-clock millisecond.
 */
let lastSendTs = 0

/** Allocate the next send timestamp. */
function nextSendTs(): number {
  lastSendTs = Math.max(Date.now(), lastSendTs + 1)
  return lastSendTs
}

/** A message as it travels through the Redis lists. */
export interface QueuedMessage {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly kind: 'text' | 'agent'
  readonly body: string
  readonly ts: number
}

/** A message as the inbox API returns it, read back from the archive. */
export interface ArchivedMessage extends QueuedMessage {
  /** True once the recipient's own fetch drained it off their inbox list. */
  readonly read: boolean
}

/** A send the channel refused; the HTTP layer maps the status to a response. */
export class MessageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class MessageStore {
  constructor(
    private readonly db: Queryable,
    private readonly redis: Redis,
  ) {}

  /**
   * Push one message onto the recipient's inbox and the sender's sent log.
   * @param from - the sender's username.
   * @param to - the recipient's username (the HTTP layer has already verified
   * the recipient is an active account).
   * @param kind - how the send originated: `text` from a browser session,
   * `agent` from a member instance's bearer token.
   * @param body - the message text.
   * @returns the queued message.
   * @throws MessageError when the body is blank, too long, or the sender is
   * over the per-minute send rate.
   */
  async send(from: string, to: string, kind: 'text' | 'agent', body: string): Promise<QueuedMessage> {
    if (body.trim() === '') throw new MessageError(400, '消息内容不能为空')
    if (body.length > MAX_BODY_CHARS) {
      throw new MessageError(400, `消息内容过长（上限 ${String(MAX_BODY_CHARS)} 字符）`)
    }
    const rateKey = `${RATE_PREFIX}${from}`
    const sends = await this.redis.incr(rateKey)
    if (sends === 1) await this.redis.expire(rateKey, 60)
    if (sends > SENDS_PER_MINUTE) throw new MessageError(429, '发送过于频繁，请稍后再试')
    const message: QueuedMessage = { id: randomUUID(), from, to, kind, body, ts: nextSendTs() }
    const raw = JSON.stringify(message)
    for (const key of [`${INBOX_PREFIX}${to}`, `${SENT_PREFIX}${from}`]) {
      await this.redis.rpush(key, raw)
      await this.redis.expire(key, RETENTION_SECS)
    }
    return message
  }

  /**
   * Fetch the caller's mailbox: drain their inbox (marking those messages
   * read) and their sent log, archive everything drained in send order, and
   * return the recent archive view covering every thread the caller is in.
   * @param user - the fetching member's username.
   * @param limit - how many of the most recent messages to return.
   * @returns the messages, oldest first.
   */
  async fetch(user: string, limit: number): Promise<ArchivedMessage[]> {
    const drained = [
      ...await this.drain(`${INBOX_PREFIX}${user}`).then(ms => ms.map(m => [m, true] as const)),
      ...await this.drain(`${SENT_PREFIX}${user}`).then(ms => ms.map(m => [m, false] as const)),
    ].sort((a, b) => a[0].ts - b[0].ts)
    for (const [message, read] of drained) await this.archive(message, read)
    const result = await this.db.query(
      `SELECT msg_id, from_user, to_user, kind, body, created_at, read_at
         FROM dsh_messages
        WHERE from_user = $1 OR to_user = $1
        ORDER BY created_at DESC, seq DESC
        LIMIT $2`,
      [user, limit],
    )
    const rows = result.rows.map(row => {
      const r = row as Record<string, unknown>
      return {
        id: String(r.msg_id),
        from: String(r.from_user),
        to: String(r.to_user),
        kind: r.kind === 'agent' ? ('agent' as const) : ('text' as const),
        body: String(r.body),
        ts: new Date(String(r.created_at)).getTime(),
        read: r.read_at !== null && r.read_at !== undefined,
      }
    })
    rows.reverse()
    return rows
  }

  /** Atomically read and destroy one channel list, dropping malformed entries. */
  private async drain(key: string): Promise<QueuedMessage[]> {
    const drained = await this.redis.eval(DRAIN_LUA, 1, key)
    const out: QueuedMessage[] = []
    if (!Array.isArray(drained)) return out
    for (const item of drained) {
      if (typeof item !== 'string') continue
      try {
        const m = JSON.parse(item) as Partial<QueuedMessage>
        if (typeof m.id === 'string' && typeof m.from === 'string' && typeof m.to === 'string'
          && (m.kind === 'text' || m.kind === 'agent') && typeof m.body === 'string' && typeof m.ts === 'number') {
          out.push(m as QueuedMessage)
        } else {
          console.error(`[team-messages] dropping entry with missing fields on ${key}`)
        }
      } catch {
        // Only a corrupt value can fail JSON.parse here: every entry this
        // store writes is a JSON string, so dropping it cannot lose a send.
        console.error(`[team-messages] dropping unparseable channel entry on ${key}`)
      }
    }
    return out
  }

  /**
   * Record a drained message in the Postgres archive. Idempotent per message
   * id: whichever drain runs second only fills in the read stamp the first
   * left null, never resets one already set.
   */
  private async archive(m: QueuedMessage, read: boolean): Promise<void> {
    await this.db.query(
      `INSERT INTO dsh_messages (msg_id, from_user, to_user, kind, body, created_at, read_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (msg_id) DO UPDATE SET read_at = COALESCE(dsh_messages.read_at, EXCLUDED.read_at)`,
      [m.id, m.from, m.to, m.kind, m.body, new Date(m.ts), read ? new Date() : null],
    )
  }
}
