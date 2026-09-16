/**
 * Self-service account registration with operator approval.
 *
 * A request creates no account. It records the applicant's work email, derives
 * the account name from the address, and sends the operator one Feishu message
 * carrying a single-use approval link. The account (with the shared default
 * password) exists only after the operator approves, so an unapproved or lost
 * request is a refusal rather than a silently usable login.
 *
 * The approval link is the credential: it carries 256 bits of entropy, is
 * stored only as a SHA-256 hash, is spent by the decision that consumes it, and
 * expires. Deciding is a single conditional UPDATE inside one transaction with
 * the account insert, so two concurrent approvals of the same link cannot both
 * create an account.
 *
 * @module dsh-team-shell/account/registrations
 */

import { createHash, randomBytes } from 'node:crypto'
import type { Queryable, TransactionalDb, UserRow } from './db.ts'
import type { CreateUserInput } from './users.ts'

/** Lifecycle of one registration request. */
export type RegistrationStatus = 'pending' | 'approved' | 'rejected' | 'notify_failed'

/** One registration request row. */
export interface RegistrationRow {
  id: string
  email: string
  username: string
  display_name: string | null
  status: RegistrationStatus
  reason: string | null
  decided_at: string | null
  decided_by: string | null
  created_at: string
  updated_at: string
}

/** Random bytes behind one approval token (256 bits). */
const TOKEN_BYTES = 32

/** Longest accepted email address (RFC 5321 forward-path limit). */
const MAX_EMAIL_LENGTH = 254

/** Account-name character set: filesystem-safe, since the name is a DSH_HOME directory. */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/u

/** Deliberately broad email check: the operator is the real filter, not a regex. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

interface RegistrationDbRow {
  id: unknown
  email: unknown
  username: unknown
  display_name: unknown
  status: unknown
  reason: unknown
  decided_at: unknown
  decided_by: unknown
  created_at: unknown
  updated_at: unknown
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function rowToRegistration(row: unknown): RegistrationRow {
  const r = row as RegistrationDbRow
  return {
    id: String(r.id),
    email: String(r.email),
    username: String(r.username),
    display_name: nullableString(r.display_name),
    status: String(r.status) as RegistrationStatus,
    reason: nullableString(r.reason),
    decided_at: nullableString(r.decided_at),
    decided_by: nullableString(r.decided_by),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  }
}

/** A rejection carrying the HTTP status and user-facing text to return. */
export class RegistrationError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'RegistrationError'
  }
}

/**
 * Derive the account name from an email address: the local part, lowercased,
 * with characters that cannot appear in a DSH_HOME directory replaced.
 * @param email - the applicant's email address.
 * @returns the derived account name, or undefined when nothing usable remains.
 */
export function deriveUsername(email: string): string | undefined {
  const at = email.lastIndexOf('@')
  if (at <= 0) return undefined
  const local = email.slice(0, at).toLowerCase()
  const cleaned = local
    .replace(/[^a-z0-9._-]+/gu, '.')
    .replace(/\.{2,}/gu, '.')
    .replace(/^[._-]+|[._-]+$/gu, '')
    .slice(0, 63)
  if (!USERNAME_PATTERN.test(cleaned) || cleaned.includes('..')) return undefined
  return cleaned
}

/** Hash an approval token into its stored form. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** What an accepted registration request produced. */
export interface RegistrationOpened {
  /** The account name that will be created on approval. */
  username: string
  /** The emailed display name, when the applicant supplied one. */
  displayName: string | null
}

export interface RegistrationOptions {
  /** Email domains allowed to register; empty accepts any domain. */
  readonly domains: readonly string[]
  /** Password issued to the account on approval. */
  readonly defaultPassword: string
  /** Lifetime of an approval link in seconds. */
  readonly ttlSecs: number
  /** Absolute entry-host base URL the approval link is built from. */
  readonly entryBaseUrl: string
  /** Send the operator one message and resolve once Feishu accepted it. */
  readonly notify: (text: string) => Promise<void>
}

/** The outcome of spending an approval token. */
export type DecisionOutcome =
  | { ok: true; action: 'approve'; registration: RegistrationRow }
  | { ok: true; action: 'reject'; registration: RegistrationRow }
  | { ok: false; reason: 'not-pending' }

/** The account directory approval writes to; `UserStore` satisfies it. */
export interface RegistrationUserDirectory {
  findByUsername(username: string): Promise<UserRow | undefined>
  /**
   * Create an account. The executor runs the insert inside the caller's
   * transaction, so a failed insert cannot consume the approval token.
   * @param input - the account's name, optional display name, and password.
   * @param executor - the checked-out client to run on.
   */
  create(input: CreateUserInput, executor?: Queryable): Promise<UserRow>
}

/**
 * Registration requests: validation, the operator notification, and the
 * transactional approval that creates the account.
 */
export class RegistrationService {
  constructor(
    private readonly db: TransactionalDb,
    private readonly users: RegistrationUserDirectory,
    private readonly options: RegistrationOptions,
  ) {}

  /**
   * Validate a registration request and notify the operator.
   * @param email - the applicant's work email address.
   * @param displayName - the applicant's name, when supplied.
   * @returns the derived account name awaiting approval.
   * @throws RegistrationError for an unusable address, a taken name, an
   * already-open request, or an undeliverable operator notification.
   */
  async open(email: string, displayName?: string): Promise<RegistrationOpened> {
    const normalizedEmail = email.trim().toLowerCase()
    if (normalizedEmail.length === 0 || normalizedEmail.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(normalizedEmail)) {
      throw new RegistrationError(400, '请填写有效的邮箱地址')
    }
    if (this.options.domains.length > 0) {
      const domain = normalizedEmail.slice(normalizedEmail.lastIndexOf('@') + 1)
      if (!this.options.domains.includes(domain)) {
        throw new RegistrationError(400, `只接受 ${this.options.domains.map(d => `@${d}`).join(' / ')} 邮箱`)
      }
    }
    const username = deriveUsername(normalizedEmail)
    if (username === undefined) {
      throw new RegistrationError(400, '无法从邮箱推导出合法的用户名，请联系管理员')
    }
    if (await this.users.findByUsername(username) !== undefined) {
      throw new RegistrationError(409, `用户名 ${username} 已被占用，请联系管理员`)
    }

    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    const name = displayName === undefined || displayName.trim() === '' ? null : displayName.trim()
    try {
      await this.db.query(
        `INSERT INTO dsh_registrations (email, username, display_name, status, token_hash)
         VALUES ($1, $2, $3, 'pending', $4)`,
        [normalizedEmail, username, name, hashToken(token)],
      )
    } catch (error) {
      // The open-request unique indexes reject a second request for the same
      // address or account name while one is still undecided.
      if (isUniqueViolation(error)) {
        throw new RegistrationError(409, '该邮箱或用户名已有待审批的申请，请等待管理员处理')
      }
      throw error
    }

    try {
      await this.options.notify(this.notificationText(normalizedEmail, username, name, token))
    } catch (error) {
      // The request is kept but marked undeliverable so the applicant may retry
      // the same address; the open-request index ignores this status.
      await this.db.query(
        `UPDATE dsh_registrations SET status = 'notify_failed', reason = $2, updated_at = now()
          WHERE token_hash = $1`,
        [hashToken(token), error instanceof Error ? error.message : String(error)],
      )
      throw new RegistrationError(502, '申请已记录，但通知管理员失败，请稍后重试或联系管理员')
    }
    return { username, displayName: name }
  }

  /**
   * Load the undecided request an approval token refers to.
   * @param token - the token from the operator's approval link.
   * @returns the pending request, or undefined when the token is unknown, spent, or expired.
   */
  async pending(token: string): Promise<RegistrationRow | undefined> {
    const result = await this.db.query(
      `SELECT * FROM dsh_registrations
        WHERE token_hash = $1 AND status = 'pending'
          AND created_at > now() - ($2::bigint * interval '1 second')`,
      [hashToken(token), this.options.ttlSecs],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : rowToRegistration(row)
  }

  /**
   * Spend an approval token. The token's row is claimed by one conditional
   * UPDATE in the same transaction as the account insert, so a replayed or
   * concurrently submitted token cannot create a second account.
   * @param token - the token from the operator's approval link.
   * @param approve - true to create the account, false to record a refusal.
   * @returns the decision, or `not-pending` when the token is unusable.
   * @throws RegistrationError when approval cannot create the account.
   */
  async decide(token: string, approve: boolean, decidedBy: string): Promise<DecisionOutcome> {
    const client = await this.db.connect()
    try {
      await client.query('BEGIN')
      const claimed = await client.query(
        `UPDATE dsh_registrations
            SET status = $2, decided_at = now(), updated_at = now(), token_hash = NULL, decided_by = $3
          WHERE token_hash = $1 AND status = 'pending'
            AND created_at > now() - ($4::bigint * interval '1 second')
          RETURNING *`,
        [hashToken(token), approve ? 'approved' : 'rejected', decidedBy, this.options.ttlSecs],
      )
      if (claimed.rows.length === 0) {
        await client.query('ROLLBACK')
        return { ok: false, reason: 'not-pending' }
      }
      const registration = rowToRegistration(claimed.rows[0])
      if (approve) {
        try {
          await this.users.create({
            username: registration.username,
            ...registration.display_name === null ? {} : { displayName: registration.display_name },
            password: this.options.defaultPassword,
          }, client)
        } catch (error) {
          await client.query('ROLLBACK')
          if (isUniqueViolation(error)) {
            throw new RegistrationError(409, `用户名 ${registration.username} 已被占用，申请保持待审批`)
          }
          throw error
        }
      }
      await client.query('COMMIT')
      return approve
        ? { ok: true, action: 'approve', registration }
        : { ok: true, action: 'reject', registration }
    } finally {
      client.release()
    }
  }

  /** The operator notification: applicant facts, both decisions, and the link's lifetime. */
  private notificationText(email: string, username: string, displayName: string | null, token: string): string {
    const link = `${this.options.entryBaseUrl}/approve?token=${token}`
    const days = Math.round(this.options.ttlSecs / 86_400)
    return [
      '【天问星】账号注册申请',
      '',
      `邮箱：${email}`,
      `用户名：${username}`,
      ...displayName === null ? [] : [`姓名：${displayName}`],
      '',
      `审批（${String(days)} 天内有效，仅可操作一次）：`,
      link,
      '',
      `批准后将以初始密码 ${this.options.defaultPassword} 创建账号，用户登录后可自行修改。`,
    ].join('\n')
  }
}

/** True for a Postgres unique-index violation (SQLSTATE 23505). */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
}
