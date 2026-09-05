/** Authentication service: login verification and session lifecycle. */

import { verifyPassword } from './password.ts'
import type { SessionStore } from './session.ts'
import { UserStore } from './users.ts'

export interface LoginResult {
  ok: boolean
  sessionId?: string
  username?: string
  userId?: string
  role?: string
  displayName?: string | null
  error?: string
}

export class AuthService {
  constructor(
    private readonly users: UserStore,
    private readonly sessions: SessionStore,
  ) {}

  /** Verify username+password and open a session on success. */
  async login(username: string, password: string): Promise<LoginResult> {
    const user = await this.users.findByUsername(username)
    if (user === undefined || user.status !== 'active') {
      return { ok: false, error: 'invalid credentials' }
    }
    if (!verifyPassword(password, user.password_hash)) {
      return { ok: false, error: 'invalid credentials' }
    }
    const sessionId = await this.sessions.create(user.user_id)
    return {
      ok: true,
      sessionId,
      userId: user.user_id,
      username: user.username,
      role: user.role,
      displayName: user.display_name,
    }
  }
}
