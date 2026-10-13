/**
 * Session cookie naming.
 *
 * Cookies are scoped by host and ignore the port, so a second team shell on
 * the same host overwrites the first shell's login unless their cookie names
 * differ. These tests pin the default that keeps today's deployments working
 * and the override that separates two shells sharing one host.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { loadEnv } from '../src/account/env.ts'
import { startAccountProxy, TEAM_SESSION_COOKIE } from '../src/reverse-proxy.ts'

/** The minimum required environment, with per-test overrides merged in. */
function envWith(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    TEAM_DB_URL: 'postgres://user:pw@127.0.0.1:5432/db',
    TEAM_REDIS_URL: 'redis://127.0.0.1:6379/0',
    ...overrides,
  }
}

describe('account session cookie name', () => {
  it('defaults to the name existing deployments already issue', () => {
    assert.equal(loadEnv(envWith()).sessionCookieName, TEAM_SESSION_COOKIE)
  })

  it('takes TEAM_SESSION_COOKIE so one host can run two shells', () => {
    const env = loadEnv(envWith({ TEAM_SESSION_COOKIE: 'dsh_team_session_dev' }))
    assert.equal(env.sessionCookieName, 'dsh_team_session_dev')
  })

  it('rejects a value that is not a cookie token', () => {
    assert.throws(
      () => loadEnv(envWith({ TEAM_SESSION_COOKIE: 'name with spaces' })),
      /TEAM_SESSION_COOKIE/,
    )
  })
})

describe('proxy session cookie name', () => {
  it('reads the configured cookie and ignores the default name', async () => {
    const server = startAccountProxy({
      port: 0,
      accountUrl: 'http://127.0.0.1:1',
      sessionCookieName: 'dsh_team_session_dev',
    })
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
        headers: { cookie: `${TEAM_SESSION_COOKIE}=present` },
      })
      // A session under the default name must not authenticate this proxy.
      assert.equal(response.status, 401)
    } finally {
      server.close()
    }
  })
})
