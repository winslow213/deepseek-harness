/** Member account operations over the dsh_users table. */

import { randomBytes } from 'node:crypto'
import type { Db, UserRow } from './db.ts'
import { rowToUser } from './db.ts'
import { hashPassword } from './password.ts'

export interface CreateUserInput {
  username: string
  displayName?: string
  role?: 'operator' | 'member'
  password: string
}

/** Issue a fresh agent token (the secret agents dial the hub with). */
export function newAgentToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export class UserStore {
  constructor(private readonly db: Db) {}

  async create(input: CreateUserInput): Promise<UserRow> {
    const userId = input.username
    const role = input.role ?? 'member'
    const agentToken = newAgentToken()
    const result = await this.db.query(
      `INSERT INTO dsh_users (user_id, username, display_name, role, status, password_hash, agent_token)
       VALUES ($1, $2, $3, $4, 'active', $5, $6)
       RETURNING *`,
      [userId, input.username, input.displayName ?? null, role, hashPassword(input.password), agentToken],
    )
    return rowToUser(result.rows[0] as Record<string, unknown>)
  }

  async findByUsername(username: string): Promise<UserRow | undefined> {
    const result = await this.db.query('SELECT * FROM dsh_users WHERE username = $1', [username])
    const row = result.rows[0]
    return row === undefined ? undefined : rowToUser(row as Record<string, unknown>)
  }

  async list(): Promise<UserRow[]> {
    const result = await this.db.query('SELECT * FROM dsh_users ORDER BY created_at')
    return result.rows.map(row => rowToUser(row as Record<string, unknown>))
  }

  async setPassword(userId: string, password: string): Promise<void> {
    await this.db.query(
      'UPDATE dsh_users SET password_hash = $2, updated_at = now() WHERE user_id = $1',
      [userId, hashPassword(password)],
    )
  }

  async rotateAgentToken(userId: string): Promise<string> {
    const token = newAgentToken()
    await this.db.query(
      'UPDATE dsh_users SET agent_token = $2, updated_at = now() WHERE user_id = $1',
      [userId, token],
    )
    return token
  }
}
