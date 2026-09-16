/**
 * Registration and approval behaviour.
 *
 * The approval path is the one that creates accounts, so these tests run
 * against the real Postgres schema (a throwaway schema per run) rather than a
 * fake query layer: the conditional UPDATE, the partial unique indexes, and the
 * transaction that keeps the token and the account insert together are the
 * behaviour under test.
 *
 * Set TEAM_DB_URL to run them; without it the suite is skipped, since a
 * connection target is operator-local and not part of any CI gate.
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SCHEMA_SQL } from '../src/account/db/schema.ts'
import { UserStore } from '../src/account/users.ts'
import { RegistrationError, RegistrationService, deriveUsername } from '../src/account/registrations.ts'
import { verifyPassword } from '../src/account/password.ts'
import { loadFeishuConfig } from '../src/account/feishu.ts'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DB_URL = process.env.TEAM_DB_URL ?? ''
const SKIP = DB_URL === '' ? 'TEAM_DB_URL is not set' : false

const DOMAINS = ['quectel.com']
const DEFAULT_PASSWORD = 'quectel@123'

/** The token embedded in an approval link the service sent. */
function tokenFrom(text: string): string {
  const match = text.match(/\/approve\?token=([A-Za-z0-9_-]+)/u)
  assert.ok(match !== null, `no approval link in notification:\n${text}`)
  return match[1] ?? ''
}

/** A notification sink that records what the service sent. */
function recorder(): { readonly sent: string[]; readonly notify: (text: string) => Promise<void> } {
  const sent: string[] = []
  return { sent, notify: async (text) => { sent.push(text) } }
}

describe('deriveUsername', () => {
  it('takes the local part, lowercased', () => {
    assert.equal(deriveUsername('Zhang.San@quectel.com'), 'zhang.san')
    assert.equal(deriveUsername('alice@quectel.com'), 'alice')
  })

  it('replaces characters that cannot appear in a DSH_HOME directory', () => {
    assert.equal(deriveUsername('john+tag@quectel.com'), 'john.tag')
    assert.equal(deriveUsername('a/b\\c@quectel.com'), 'a.b.c')
    assert.equal(deriveUsername('first..last@quectel.com'), 'first.last')
  })

  it('rejects addresses whose derived name cannot be a directory', () => {
    assert.equal(deriveUsername('___@quectel.com'), undefined)
    assert.equal(deriveUsername('..@quectel.com'), undefined)
    assert.equal(deriveUsername('@quectel.com'), undefined)
    assert.equal(deriveUsername('no-at-sign'), undefined)
  })

  it('strips separators the address may not begin or end with', () => {
    assert.equal(deriveUsername('.hidden@quectel.com'), 'hidden')
    assert.equal(deriveUsername('trailing.@quectel.com'), 'trailing')
  })

  it('never yields a path traversal or a leading dot', () => {
    for (const address of ['../../etc@quectel.com', '..@quectel.com', '.a@quectel.com', 'a/../b@quectel.com']) {
      const derived = deriveUsername(address)
      if (derived === undefined) continue
      assert.doesNotMatch(derived, /[/\\]/u)
      assert.doesNotMatch(derived, /^\./u)
      assert.ok(!derived.includes('..'))
    }
  })
})

describe('loadFeishuConfig', () => {
  it('resolves the bot app id and the app secret through the credential reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-'))
    try {
      await mkdir(join(root, 'winslow', 'integrations', 'dsh-feishu'), { recursive: true })
      await writeFile(join(root, 'winslow', 'integrations', 'dsh-feishu', 'config.json'), JSON.stringify({
        version: 2,
        bots: [{
          appId: 'cli_test0001',
          secretRef: 'DSH_FEISHU_APP_SECRET_TEST',
          ownerOpenIds: ['ou_test_owner'],
          domain: 'feishu',
        }],
      }))
      await writeFile(join(root, 'winslow', '.credentials.yaml'), [
        'version: 3',
        'records: {}',
        'refs:',
        '  DSH_FEISHU_APP_SECRET_TEST: s3cret-value',
        '',
      ].join('\n'))

      const config = loadFeishuConfig({ DSH_USERS_ROOT: root })
      assert.deepEqual(config, {
        appId: 'cli_test0001',
        appSecret: 's3cret-value',
        ownerOpenId: 'ou_test_owner',
        domain: 'feishu',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prefers the TEAM_FEISHU_* environment over the integration file', () => {
    const config = loadFeishuConfig({
      DSH_USERS_ROOT: '/nonexistent',
      TEAM_FEISHU_APP_ID: 'cli_env',
      TEAM_FEISHU_APP_SECRET: 'env-secret',
      TEAM_FEISHU_OWNER_OPEN_ID: 'ou_env',
      TEAM_FEISHU_DOMAIN: 'lark',
    })
    assert.equal(config?.appId, 'cli_env')
    assert.equal(config?.domain, 'lark')
  })

  it('returns undefined when no integration is configured', () => {
    assert.equal(loadFeishuConfig({ DSH_USERS_ROOT: '/nonexistent' }), undefined)
  })
})

describe('RegistrationService', { skip: SKIP }, () => {
  let pool: pg.Pool
  let schema: string
  let users: UserStore

  const service = (options: Partial<ConstructorParameters<typeof RegistrationService>[2]> = {}): {
    registrations: RegistrationService
    sent: string[]
  } => {
    const sink = recorder()
    const registrations = new RegistrationService(pool, users, {
      domains: DOMAINS,
      defaultPassword: DEFAULT_PASSWORD,
      ttlSecs: 3600,
      entryBaseUrl: 'http://10.33.2.56:3999',
      notify: sink.notify,
      ...options,
    })
    return { registrations, sent: sink.sent }
  }

  before(async () => {
    schema = `dsh_reg_test_${randomBytes(6).toString('hex')}`
    // A single client, not a pool: SET search_path is session state, and a pool
    // would hand the schema setup to a different connection than the SET.
    const admin = new pg.Client({ connectionString: DB_URL })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`)
      await admin.query(`SET search_path TO "${schema}"`)
      await admin.query(SCHEMA_SQL)
    } finally {
      await admin.end()
    }
    pool = new pg.Pool({ connectionString: DB_URL, options: `-c search_path=${schema}` })
  })

  after(async () => {
    await pool.end()
    const admin = new pg.Client({ connectionString: DB_URL })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await admin.end()
    }
  })

  /** Each test starts from an empty registration table and no extra accounts. */
  before(async () => {
    users = new UserStore(pool)
    await pool.query('DELETE FROM dsh_registrations')
    await pool.query('DELETE FROM dsh_users')
  })

  it('records a request, derives the name from the address, and links the operator to it', async () => {
    const { registrations, sent } = service()
    const opened = await registrations.open('Zhang.San@quectel.com', '张三')

    assert.equal(opened.username, 'zhang.san')
    assert.equal(opened.displayName, '张三')
    assert.equal(sent.length, 1)
    assert.match(sent[0] ?? '', /Zhang\.San@quectel\.com|zhang\.san@quectel\.com/u)
    assert.match(sent[0] ?? '', /http:\/\/10\.33\.2\.56:3999\/approve\?token=/u)
    assert.match(sent[0] ?? '', new RegExp(DEFAULT_PASSWORD, 'u'))

    // The request is not an account.
    assert.equal(await users.findByUsername('zhang.san'), undefined)
  })

  it('rejects an address outside the allowed domains', async () => {
    const { registrations } = service()
    await assert.rejects(
      () => registrations.open('someone@gmail.com'),
      (error: unknown) => error instanceof RegistrationError && error.status === 400,
    )
  })

  it('accepts any domain when the allowlist is empty', async () => {
    const { registrations } = service({ domains: [] })
    const opened = await registrations.open('someone@gmail.com')
    assert.equal(opened.username, 'someone')
  })

  it('rejects a malformed address', async () => {
    const { registrations } = service()
    for (const email of ['', '   ', 'not-an-email', 'a@b', 'a b@quectel.com']) {
      await assert.rejects(
        () => registrations.open(email),
        (error: unknown) => error instanceof RegistrationError && error.status === 400,
        `expected ${JSON.stringify(email)} to be rejected`,
      )
    }
  })

  it('refuses a name that an existing account already holds', async () => {
    await users.create({ username: 'taken', password: 'existing-password' })
    const { registrations } = service()
    await assert.rejects(
      () => registrations.open('taken@quectel.com'),
      (error: unknown) => error instanceof RegistrationError && error.status === 409,
    )
  })

  it('refuses a second open request for the same address', async () => {
    const { registrations } = service()
    await registrations.open('dup@quectel.com')
    await assert.rejects(
      () => registrations.open('DUP@quectel.com'),
      (error: unknown) => error instanceof RegistrationError && error.status === 409,
    )
  })

  it('keeps the request retryable when the operator notification fails', async () => {
    const { registrations } = service({
      notify: async () => { throw new Error('feishu unreachable') },
    })
    await assert.rejects(
      () => registrations.open('retry@quectel.com'),
      (error: unknown) => error instanceof RegistrationError && error.status === 502,
    )
    const rows = await pool.query("SELECT status FROM dsh_registrations WHERE email = 'retry@quectel.com'")
    assert.equal((rows.rows[0] as { status: string }).status, 'notify_failed')

    // The applicant may try again; the delivered path then succeeds.
    const { registrations: retry, sent } = service()
    const opened = await retry.open('retry@quectel.com')
    assert.equal(opened.username, 'retry')
    assert.equal(sent.length, 1)
  })

  it('creates the account with the default password on approval', async () => {
    const { registrations, sent } = service()
    const opened = await registrations.open('newbie@quectel.com', '新同学')
    const token = tokenFrom(sent[0] ?? '')

    const pending = await registrations.pending(token)
    assert.equal(pending?.email, 'newbie@quectel.com')

    const outcome = await registrations.decide(token, true, 'operator-link')
    assert.equal(outcome.ok, true)

    const created = await users.findByUsername(opened.username)
    assert.ok(created !== undefined)
    assert.equal(created.role, 'member')
    assert.equal(created.status, 'active')
    assert.equal(created.display_name, '新同学')
    assert.ok(verifyPassword(DEFAULT_PASSWORD, created.password_hash))
    assert.ok(!verifyPassword('something-else', created.password_hash))

    const rows = await pool.query("SELECT status, token_hash FROM dsh_registrations WHERE email = 'newbie@quectel.com'")
    assert.equal((rows.rows[0] as { status: string }).status, 'approved')
    assert.equal((rows.rows[0] as { token_hash: string | null }).token_hash, null)
  })

  it('spends the token, so a replay cannot act again', async () => {
    const { registrations, sent } = service()
    await registrations.open('replay@quectel.com')
    const token = tokenFrom(sent[0] ?? '')

    assert.equal((await registrations.decide(token, true, 'operator-link')).ok, true)
    assert.equal(await registrations.pending(token), undefined)

    const second = await registrations.decide(token, true, 'operator-link')
    assert.deepEqual(second, { ok: false, reason: 'not-pending' })
  })

  it('creates exactly one account when the same token is submitted twice concurrently', async () => {
    const { registrations, sent } = service()
    await registrations.open('race@quectel.com')
    const token = tokenFrom(sent[0] ?? '')

    const outcomes = await Promise.all([
      registrations.decide(token, true, 'operator-link'),
      registrations.decide(token, true, 'operator-link'),
    ])
    assert.equal(outcomes.filter(o => o.ok).length, 1)

    const rows = await pool.query("SELECT count(*)::int AS n FROM dsh_users WHERE username = 'race'")
    assert.equal((rows.rows[0] as { n: number }).n, 1)
  })

  it('creates no account when the operator rejects', async () => {
    const { registrations, sent } = service()
    await registrations.open('declined@quectel.com')
    const token = tokenFrom(sent[0] ?? '')

    const outcome = await registrations.decide(token, false, 'operator-link')
    assert.equal(outcome.ok, true)
    assert.equal(await users.findByUsername('declined'), undefined)

    const rows = await pool.query("SELECT status FROM dsh_registrations WHERE email = 'declined@quectel.com'")
    assert.equal((rows.rows[0] as { status: string }).status, 'rejected')
  })

  it('refuses an expired approval link', async () => {
    const { registrations, sent } = service({ ttlSecs: 60 })
    await registrations.open('stale@quectel.com')
    const token = tokenFrom(sent[0] ?? '')
    await pool.query("UPDATE dsh_registrations SET created_at = now() - interval '2 hours' WHERE email = 'stale@quectel.com'")

    assert.equal(await registrations.pending(token), undefined)
    assert.deepEqual(await registrations.decide(token, true, 'operator-link'), { ok: false, reason: 'not-pending' })
    assert.equal(await users.findByUsername('stale'), undefined)
  })

  it('refuses an unknown token', async () => {
    const { registrations } = service()
    assert.equal(await registrations.pending('not-a-real-token'), undefined)
    assert.deepEqual(
      await registrations.decide('not-a-real-token', true, 'operator-link'),
      { ok: false, reason: 'not-pending' },
    )
  })
})
