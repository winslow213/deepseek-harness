/** Spawned-instance registration (user → loopback port + launch token). */

import type { Db } from './db.ts'

export interface InstanceRow {
  user_id: string
  port: number
  pid: number | null
  launch_token: string | null
  launched_at: string
  last_seen_at: string
}

export class InstanceStore {
  constructor(private readonly db: Db) {}

  /** Register (or refresh) the loopback port and launch token of a user's spawned dsh instance. */
  async upsert(userId: string, port: number, launchToken?: string, pid?: number): Promise<void> {
    // The shell child self-registers without a pid; COALESCE keeps the pid the
    // account service recorded when it spawned the process from being wiped.
    await this.db.query(
      `INSERT INTO dsh_instances (user_id, port, launch_token, pid, launched_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (user_id) DO UPDATE
         SET port = EXCLUDED.port,
             launch_token = COALESCE(EXCLUDED.launch_token, dsh_instances.launch_token),
             pid = COALESCE(EXCLUDED.pid, dsh_instances.pid), updated_at = now()`,
      [userId, port, launchToken ?? null, pid ?? null],
    )
  }

  /** Refresh the instance's activity timestamp (a proxy route decision observed the session). */
  async touch(userId: string): Promise<void> {
    await this.db.query('UPDATE dsh_instances SET last_seen_at = now() WHERE user_id = $1', [userId])
  }

  /**
   * List the users whose instance has been idle longer than the threshold —
   * that is, whose `last_seen_at` predates `now() - idleSecs`.
   * @param idleSecs - the idle timeout in seconds.
   */
  async idleUsers(idleSecs: number): Promise<string[]> {
    const result = await this.db.query(
      `SELECT user_id FROM dsh_instances
       WHERE last_seen_at < now() - make_interval(secs => $1)
       ORDER BY last_seen_at`,
      [idleSecs],
    )
    return result.rows.map(row => String((row as Record<string, unknown>).user_id))
  }

  /** Look up the running port for one user. */
  async portFor(userId: string): Promise<number | undefined> {
    const result = await this.db.query('SELECT port FROM dsh_instances WHERE user_id = $1', [userId])
    const row = result.rows[0] as { port?: unknown } | undefined
    return row === undefined || typeof row.port !== 'number' ? undefined : row.port
  }

  /** Look up the running port and launch token for one user. */
  async routeFor(userId: string): Promise<{ port: number; launchToken: string | undefined } | undefined> {
    const result = await this.db.query('SELECT port, launch_token FROM dsh_instances WHERE user_id = $1', [userId])
    const row = result.rows[0] as { port?: unknown; launch_token?: unknown } | undefined
    if (row === undefined || typeof row.port !== 'number') return undefined
    return { port: row.port, launchToken: typeof row.launch_token === 'string' && row.launch_token !== '' ? row.launch_token : undefined }
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
      launch_token: (row as Record<string, unknown>).launch_token === null ? null : String((row as Record<string, unknown>).launch_token),
      launched_at: String((row as Record<string, unknown>).launched_at),
      last_seen_at: String((row as Record<string, unknown>).last_seen_at),
    }))
  }
}
