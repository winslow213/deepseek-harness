/** Postgres pool for the account store. */

import pg from 'pg'
import { SCHEMA_SQL } from './db/schema.ts'

const { Pool } = pg

export type Db = pg.Pool

/** Create a pool and apply the schema (idempotent). */
export async function createDb(url: string): Promise<Db> {
  const pool = new Pool({ connectionString: url })
  await pool.query(SCHEMA_SQL)
  return pool
}

export interface UserRow {
  user_id: string
  username: string
  display_name: string | null
  role: string
  status: string
  password_hash: string
  agent_token: string
  created_at: string
  updated_at: string
}

export function rowToUser(row: Record<string, unknown>): UserRow {
  return {
    user_id: String(row.user_id),
    username: String(row.username),
    display_name: row.display_name === null || row.display_name === undefined ? null : String(row.display_name),
    role: String(row.role),
    status: String(row.status),
    password_hash: String(row.password_hash),
    agent_token: String(row.agent_token),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}

/** User-facing projection without password or token material. */
export function publicUser(u: UserRow): {
  user_id: string
  username: string
  display_name: string | null
  role: string
  status: string
} {
  return {
    user_id: u.user_id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    status: u.status,
  }
}
