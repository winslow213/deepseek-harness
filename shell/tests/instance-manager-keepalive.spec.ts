/**
 * Keep-alive watchdog policy: an account marked `idle_exempt` must not stay
 * down after its instance dies. `restoreKeptAlive` only ran once at service
 * start, so a crash after boot left the account's IM bot silently dead.
 *
 * These cases cover the policy, not the spawn machinery — `ensure` is
 * overridden so no process is started.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InstanceManager, type InstanceManagerOptions } from '../src/account/instance-manager.ts'

interface FakeStores {
  readonly options: InstanceManagerOptions
  readonly ensured: string[]
  readonly stopped: string[]
  readonly idle: string[]
  idleToReap: string[]
  exempt: string[]
  failFor: Set<string>
  listError?: Error
}

function fakeStores(): FakeStores {
  const state: FakeStores = {
    ensured: [],
    stopped: [],
    idle: [],
    idleToReap: [],
    exempt: [],
    failFor: new Set<string>(),
    options: undefined as unknown as InstanceManagerOptions,
  }
  const options = {
    instances: {
      idleUsers: async (_secs: number) => {
        state.idle.push(...state.idleToReap)
        return state.idleToReap
      },
      remove: async () => {},
      routeFor: async () => undefined,
      list: async () => [] as { userId: string; port: number }[],
      upsert: async () => {},
    },
    users: {
      listIdleExemptUserIds: async () => {
        if (state.listError !== undefined) throw state.listError
        return state.exempt
      },
    },
    portStart: 32000,
    portEnd: 32010,
    idleTimeoutSecs: 1800,
  } as unknown as InstanceManagerOptions
  state.options = options
  return state
}

/** Records `ensure` calls instead of starting a supervised instance. */
class RecordingManager extends InstanceManager {
  constructor(readonly state: FakeStores) {
    super(state.options)
  }

  override async stop(userId: string): Promise<void> {
    this.state.stopped.push(userId)
  }

  override async ensure(userId: string): Promise<void> {
    this.state.ensured.push(userId)
    const failure = this.state.failFor.get(userId)
    if (failure !== undefined) throw new Error(failure)
  }
}

/**
 * Point the watchdog's bot scan at a throwaway users root. The union is what
 * these cases exercise, so the scan runs for real against this tree rather than
 * being stubbed out.
 */
let usersRoot: string
let savedRoot: string | undefined
beforeEach(() => {
  usersRoot = mkdtempSync(join(tmpdir(), 'dsh-keepalive-'))
  savedRoot = process.env.DSH_USERS_ROOT
  process.env.DSH_USERS_ROOT = usersRoot
})
afterEach(() => {
  if (savedRoot === undefined) delete process.env.DSH_USERS_ROOT
  else process.env.DSH_USERS_ROOT = savedRoot
  rmSync(usersRoot, { recursive: true, force: true })
})

/** Write one account's IM binding as `@xmanrui/dsh-im` stores it. */
function bindBot(user: string, channel: string, botId: string): void {
  const dir = join(usersRoot, user, 'integrations', channel)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    version: 2,
    bots: [{ id: botId, appId: 'cli_test' }],
  }))
  writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({
    version: 2,
    workspaces: { [botId]: join(usersRoot, user, 'workspace') },
  }))
}

describe('instance-manager keep-alive watchdog', () => {
  it('restarts every idle-exempt account on each sweep', async () => {
    const state = fakeStores()
    state.exempt = ['darcy', 'curtis']
    bindBot('darcy', 'dsh-feishu', 'bot_darcy')
    bindBot('curtis', 'dsh-feishu', 'bot_curtis')
    await new RecordingManager(state).sweep()
    assert.deepEqual(state.ensured, ['darcy', 'curtis'])
  })

  it('leaves a healthy exempt account alone through ensure idempotence', async () => {
    const state = fakeStores()
    state.exempt = ['darcy']
    bindBot('darcy', 'dsh-feishu', 'bot_darcy')
    const manager = new RecordingManager(state)
    await manager.sweep()
    await manager.sweep()
    // The watchdog re-asks every pass; `ensure` is what makes that cheap, so a
    // second pass must still be issued rather than the policy caching state.
    assert.equal(state.ensured.length, 2)
  })

  it('keeps restarting the remaining accounts when one fails to start', async () => {
    const state = fakeStores()
    state.exempt = ['broken', 'darcy', 'curtis']
    bindBot('broken', 'dsh-feishu', 'bot_broken')
    bindBot('darcy', 'dsh-feishu', 'bot_darcy')
    bindBot('curtis', 'dsh-feishu', 'bot_curtis')
    state.failFor.add('broken')
    await new RecordingManager(state).sweep()
    assert.deepEqual(state.ensured, ['broken', 'darcy', 'curtis'])
  })

  it('keeps a bot-connected account alive even when it is not idle-exempt', async () => {
    const state = fakeStores()
    state.exempt = []
    bindBot('anders', 'dsh-weixin', 'wx_anders')
    await new RecordingManager(state).sweep()
    // A bot reaches its agent only through this instance; without the union the
    // account stays dead and the bot silently stops answering.
    assert.deepEqual(state.ensured, ['anders'])
  })

  it('keeps an idle-exempt account alive even when it has no bot', async () => {
    const state = fakeStores()
    state.exempt = ['lange.li']
    await new RecordingManager(state).sweep()
    assert.deepEqual(state.ensured, ['lange.li'])
  })

  it('starts each account once when both reasons name it', async () => {
    const state = fakeStores()
    state.exempt = ['darcy']
    bindBot('darcy', 'dsh-feishu', 'bot_darcy')
    await new RecordingManager(state).sweep()
    assert.deepEqual(state.ensured, ['darcy'])
  })

  it('ignores an integration directory with no bot bound', async () => {
    const state = fakeStores()
    state.exempt = []
    // `dsh-im` holds shared state, not a channel, and a channel may exist with
    // an empty bot list before anything is registered.
    mkdirSync(join(usersRoot, 'clay', 'integrations', 'dsh-im'), { recursive: true })
    writeFileSync(join(usersRoot, 'clay', 'integrations', 'dsh-im', 'interface-language.json'), '{}')
    mkdirSync(join(usersRoot, 'lange.li', 'integrations', 'dsh-feishu'), { recursive: true })
    writeFileSync(join(usersRoot, 'lange.li', 'integrations', 'dsh-feishu', 'config.json'),
      JSON.stringify({ version: 2, bots: [] }))
    await new RecordingManager(state).sweep()
    assert.deepEqual(state.ensured, [])
  })

  it('sweeps idle reclaim and keep-alive in one pass', async () => {
    const state = fakeStores()
    state.exempt = ['darcy']
    bindBot('darcy', 'dsh-feishu', 'bot_darcy')
    state.idleToReap = ['nora.yao']
    await new RecordingManager(state).sweep()
    assert.deepEqual(state.stopped, ['nora.yao'])
    assert.deepEqual(state.ensured, ['darcy'])
  })

  it('never reclaims an account the keep-alive half protects', async () => {
    const state = fakeStores()
    // anders has a bot but was never marked idle-exempt. Reclaiming it would
    // drop its bot connection, and the next sweep would start it again — the
    // account would cycle on every idle timeout.
    state.exempt = []
    bindBot('anders', 'dsh-weixin', 'wx_anders')
    state.idleToReap = ['anders']
    await new RecordingManager(state).sweep()
    assert.deepEqual(state.stopped, [])
    assert.deepEqual(state.ensured, ['anders'])
  })

  it('never reclaims an idle-exempt account', async () => {
    const state = fakeStores()
    state.exempt = ['lange.li']
    state.idleToReap = ['lange.li']
    await new RecordingManager(state).sweep()
    assert.deepEqual(state.stopped, [])
  })

  it('reclaims nothing when the keep-alive set cannot be read', async () => {
    const state = fakeStores()
    state.listError = new Error('store unavailable')
    state.idleToReap = ['nora.yao']
    await new RecordingManager(state).sweep()
    // An unreadable set must not be read as empty: that would reclaim exactly
    // the accounts this pass exists to protect.
    assert.deepEqual(state.stopped, [])
  })

  it('survives a failure to list exempt accounts', async () => {
    const state = fakeStores()
    state.exempt = ['darcy']
    bindBot('darcy', 'dsh-feishu', 'bot_darcy')
    state.listError = new Error('store unavailable')
    await new RecordingManager(state).sweep()
    // A sweep that cannot read the list must not abort the idle reaping half
    // nor throw into the timer callback, where nothing would catch it.
    assert.deepEqual(state.ensured, [])
  })
})
