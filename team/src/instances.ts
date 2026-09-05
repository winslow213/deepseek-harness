/** Spawned-instance registration (user → loopback port). */

import type { Db } from './db.ts'

export interface InstanceRow {
  user_id: string
  port: number
  pid: number | null
  launched_at: string
}

export class InstanceStore {
  constructor(private readonly db: Db) {}

  /** Register (or refresh) the loopback port of a user's spawned dsh instance. */
  async upsert(userId: string, port: number, pid?: number): Promise<void> {
    await this.db.query(
      `INSERT INTO dsh_instances (user_id, port, pid, launched_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (user_id) DO UPDATE SET port = EXCLUDED.port, pid = EXCLUDED.pid, updated_at = now()`,
      [userId, port, pid ?? null],
    )
  }

  /** Look up the running port for one user. */
  async portFor(userId: string): Promise<number | undefined> {
    const result = await this.db.query('SELECT port FROM dsh_instances WHERE user_id = $1', [userId])
    const row = result.rows[0] as { port?: unknown } | undefined
    return row === undefined || typeof row.port !== 'number' ? undefined : row.port
  }

  /** Remove the registration (instance stopped). */
  async remove(userId: string): Promise<void> {
    await this.db.query('DELETE FROM dsh_instances WHERE user_id = $1', [userId])
  }

  async list(): Promise<InstanceRow[]> {
    const result = await this.db.query('SELECT * FROM dsh_instances ORDER BY user_id')
    return result.rows.map(row => ({
      user_id: String((row as Record<string, unknown>).user_id),
      port: Number((row as Record<string, unknown>).port),
      pid: (row as Record<string, unknown>).pid === null ? null : Number((row as Record<string, unknown>).pid),
      launched_at: String((row as Record<string, unknown>).launched_at),
    }))
  }
}
