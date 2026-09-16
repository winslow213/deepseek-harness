/** Postgres pool for the account store. */

import pg from 'pg'
import { SCHEMA_SQL } from './db/schema.ts'

const { Pool } = pg

export type Db = pg.Pool

/**
 * The query surface stores depend on. A `Pool` and a checked-out `PoolClient`
 * both satisfy it, so a store can run inside a caller's transaction without a
 * second implementation.
 */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
}

/** A checked-out client, released when its transaction ends. */
export interface QueryableClient extends Queryable {
  release(): void
}

/** A pool: queryable directly, or able to check out a client for one transaction. */
export interface TransactionalDb extends Queryable {
  connect(): Promise<QueryableClient>
}

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
  /** Whitelisted against the idle-instance reclaim sweep when true. */
  idle_exempt: boolean
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
    idle_exempt: row.idle_exempt === true,
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
