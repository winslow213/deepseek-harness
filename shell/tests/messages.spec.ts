/**
 * Message channel behaviour.
 *
 * Redis is the transport and Postgres the archive, so the store tests run
 * against both real services: a throwaway schema per run for the archive (the
 * same pattern as registration.spec.ts) and unique usernames for the channel
 * lists, so a run never touches a real member's keys. Set TEAM_DB_URL and
 * TEAM_REDIS_URL to run them; without a connection target they are skipped,
 * since targets are operator-local and not part of any CI gate. The routing
 * checks at the end need neither service and always run.
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { Redis } from 'ioredis'
import { SCHEMA_SQL } from '../src/account/db/schema.ts'
import { MessageError, MessageStore } from '../src/account/messages.ts'
import { createAccountServer } from '../src/account/http.ts'

const DB_URL = process.env.TEAM_DB_URL ?? ''
const REDIS_URL = process.env.TEAM_REDIS_URL ?? ''
const SKIP = DB_URL === '' || REDIS_URL === '' ? 'TEAM_DB_URL/TEAM_REDIS_URL not set' : false

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`
const schema = `msgtest_${RUN}`
const ALICE = `alice_${RUN}`
const BOB = `bob_${RUN}`
const CAROL = `carol_${RUN}`

let pool: pg.Pool
let redis: Redis
let store: MessageStore

describe('MessageStore', { skip: SKIP }, () => {
  before(async () => {
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
    redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 })
    await redis.connect()
    store = new MessageStore(pool, redis)
  })

  after(async () => {
    await pool.end()
    for (const user of [ALICE, BOB, CAROL]) {
      await redis.del(`dsh-msg:inbox:${user}`, `dsh-msg:sent:${user}`, `dsh-msg:rl:${user}`)
    }
    await redis.quit().catch(() => {})
    const admin = new pg.Client({ connectionString: DB_URL })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await admin.end()
    }
  })

  it('archives nothing until a fetch drains the channel, then converges on one row', async () => {
    const sent = await store.send(ALICE, BOB, 'text', '通道自检 1')
    let archived = await pool.query('SELECT * FROM dsh_messages')
    assert.equal(archived.rowCount, 0)
    assert.equal(await redis.llen(`dsh-msg:inbox:${BOB}`), 1)
    assert.equal(await redis.llen(`dsh-msg:sent:${ALICE}`), 1)

    // The sender's fetch archives their sent copy without marking it read.
    const outbox = await store.fetch(ALICE, 50)
    assert.equal(outbox.length, 1)
    assert.equal(outbox[0]?.body, '通道自检 1')
    assert.equal(outbox[0]?.read, false)

    // The recipient's fetch drains their inbox and marks it read.
    const inbox = await store.fetch(BOB, 50)
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0]?.read, true)

    // Both drains converged on one archive row for the one message id.
    archived = await pool.query('SELECT msg_id, read_at FROM dsh_messages')
    assert.equal(archived.rowCount, 1)
    assert.equal((archived.rows[0] as Record<string, unknown>).msg_id, sent.id)
    assert.ok((archived.rows[0] as Record<string, unknown>).read_at !== null)

    // The channel is empty after both fetches; the archive still serves history.
    assert.equal(await redis.llen(`dsh-msg:inbox:${BOB}`), 0)
    const again = await store.fetch(BOB, 50)
    assert.equal(again.length, 1)
  })

  it('keeps a thread in send order across both directions', async () => {
    await store.send(ALICE, BOB, 'text', 'a1')
    await store.send(BOB, ALICE, 'text', 'b1')
    await store.send(ALICE, BOB, 'text', 'a2')
    const view = await store.fetch(ALICE, 50)
    assert.deepEqual(view.map(m => `${m.from}:${m.body}`), [`${ALICE}:a1`, `${BOB}:b1`, `${ALICE}:a2`])
  })

  it('rejects blank and oversized bodies without consuming the rate budget', async () => {
    const rateBefore = await redis.get(`dsh-msg:rl:${ALICE}`)
    await assert.rejects(
      () => store.send(ALICE, BOB, 'text', ' \n '),
      (e: unknown) => e instanceof MessageError && e.status === 400,
    )
    await assert.rejects(
      () => store.send(ALICE, BOB, 'text', 'x'.repeat(65537)),
      (e: unknown) => e instanceof MessageError && e.status === 400,
    )
    assert.equal(await redis.get(`dsh-msg:rl:${ALICE}`), rateBefore)
  })

  it('rate limits a fresh sender past the per-minute budget', async () => {
    for (let i = 0; i < 60; i++) await store.send(CAROL, ALICE, 'text', `burst ${i}`)
    await assert.rejects(
      () => store.send(CAROL, ALICE, 'text', 'over'),
      (e: unknown) => e instanceof MessageError && e.status === 429,
    )
  })
})

describe('account server message-center routing', () => {
  let server: ReturnType<typeof createAccountServer>
  let base = ''

  before(async () => {
    // Every path below is requested without credentials, so each handler stops
    // at its own check before touching a store; the stubs only have to exist.
    const routes = {
      messages: { send: async () => { throw new Error('unreachable') }, fetch: async () => [] },
      users: { findByUsername: async () => undefined, findByAgentToken: async () => undefined, listActiveDirectory: async () => [] },
      sessions: { lookup: async () => undefined },
    }
    server = createAccountServer(routes as unknown as Parameters<typeof createAccountServer>[0])
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    base = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`
  })

  after(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  })

  it('dispatches every member message-center path instead of the router 404', async () => {
    const sent = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'nobody', body: 'hi' }),
    })
    assert.equal(sent.status, 401)
    assert.equal((await fetch(`${base}/api/messages`)).status, 401)
    assert.equal((await fetch(`${base}/api/messages/contacts`)).status, 401)
    const page = await fetch(`${base}/inbox`, { redirect: 'manual' })
    assert.equal(page.status, 302)
    assert.equal(page.headers.get('location'), '/')
  })

  it('answers an unrouted path with the router 404 body', async () => {
    const res = await fetch(`${base}/api/messages/nope`)
    assert.equal(res.status, 404)
    assert.match(await res.text(), /no route for/)
  })
})
