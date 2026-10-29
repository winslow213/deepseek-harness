/**
 * End-to-end PTY over the hub: one real hub, one real agent dialing it from a
 * child process, and a real shell allocated on this host. The consumer under
 * test is the same `openRemoteTerminal` the browser terminal uses, so a passing
 * case proves the whole path — protocol frames, hub relay, agent allocation,
 * and the client handle — against a live process rather than a mock.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createHub } from '../src/remote/hub.ts'
import { openRemoteTerminal, RemotePtyError } from '../src/remote/pty-client.ts'

const USER = 'pty-user'
const TOKEN = 'pty-secret'
const AGENT_ENTRY = fileURLToPath(new URL('../src/remote/agent.ts', import.meta.url))

/** Extra time for the child agent to compile and dial in. */
const START_LIMIT_MS = 30_000

/** A hub on ephemeral ports plus one child agent serving `root`. */
async function stack(root: string) {
  const hub = createHub({
    agentPort: 0, controlPort: 0, agentHost: '127.0.0.1', controlHost: '127.0.0.1',
    tokens: new Map([[USER, TOKEN]]), heartbeatMs: 60_000,
  })
  await hub.ready
  const control = `http://127.0.0.1:${String(hub.controlPort)}`
  const agent: ChildProcess = spawn(process.execPath, [
    '--import', 'tsx/esm', AGENT_ENTRY,
    '--user', USER, '--hub', `127.0.0.1:${String(hub.agentPort)}`, '--token', TOKEN,
    '--root', root, '--allow-command', 'bash', '--allow-command', 'sh',
    '--name', 'pty-test-agent',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  // Drain the agent's log so a full pipe buffer can never stall its channel.
  let log = ''
  agent.stderr?.setEncoding('utf8')
  agent.stderr?.on('data', (chunk: string) => { log += chunk })
  const exited = new Promise<void>((resolve) => { agent.once('exit', () => { resolve() }) })
  const deadline = Date.now() + START_LIMIT_MS
  for (;;) {
    const response = await fetch(`${control}/api/agents`).catch(() => undefined)
    if (response?.ok === true) {
      const agents = await response.json() as { user?: string }[]
      if (agents.some(entry => entry.user === USER)) break
    }
    if (Date.now() > deadline || agent.exitCode !== null) {
      throw new Error(`the child agent never came online\n${log}`)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return {
    hub, control, agent,
    async stop() {
      agent.kill('SIGKILL')
      await exited
      await hub.close()
    },
  }
}

/**
 * Accumulate output until `needle` appears, then return everything seen.
 *
 * The listener stays attached for the whole wait: detaching between polls
 * drops any chunk the stream emits while nobody is listening.
 */
async function readUntil(output: NodeJS.ReadableStream, needle: string, ms = 20_000): Promise<string> {
  const seen: Buffer[] = []
  const text = (): string => Buffer.concat(seen).toString('utf8')
  const reached = await new Promise<boolean>((resolveReached) => {
    const onData = (chunk: Buffer): void => {
      seen.push(chunk)
      if (!text().includes(needle)) return
      clearTimeout(timer)
      output.off('data', onData)
      resolveReached(true)
    }
    const timer = setTimeout(() => {
      output.off('data', onData)
      resolveReached(false)
    }, ms)
    output.on('data', onData)
  })
  if (!reached) throw new Error(`timed out waiting for ${JSON.stringify(needle)}; saw ${JSON.stringify(text())}`)
  return text()
}

const SHELL = ['bash', '--noprofile', '--norc', '-i']

describe('remote PTY over the hub', () => {
  it('runs a shell on the agent host, carries input and output, and reports its exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pty-root-'))
    const h = await stack(root)
    try {
      const terminal = await openRemoteTerminal({ hubUrl: h.control, user: USER },
        { argv: SHELL, cwd: root, cols: 100, rows: 30, terminalType: 'xterm-256color' })
      assert.ok(terminal.pid > 0, 'the agent reports the allocated process id')
      await terminal.write('echo pty-ready-$((6*7))\r')
      assert.match(await readUntil(terminal.output, 'pty-ready-42'), /pty-ready-42/u)
      await terminal.resize(120, 40)
      await terminal.write('exit 3\r')
      assert.equal((await terminal.done).exitCode, 3)
    } finally {
      await h.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs the shell in the requested working directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pty-root-'))
    const h = await stack(root)
    try {
      const terminal = await openRemoteTerminal({ hubUrl: h.control, user: USER },
        { argv: SHELL, cwd: root, cols: 80, rows: 24, terminalType: 'xterm-256color' })
      await terminal.write('echo "PWD-IS=$(pwd)"\r')
      // The echo of the command line carries `PWD-IS=$(pwd)`, so wait for the
      // expanded form the shell prints.
      assert.match(await readUntil(terminal.output, `PWD-IS=${root}`), new RegExp(`PWD-IS=${root.replaceAll('/', '\\/')}`, 'u'))
      await terminal.terminate()
    } finally {
      await h.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a command the agent does not allow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pty-root-'))
    const h = await stack(root)
    try {
      await assert.rejects(
        openRemoteTerminal({ hubUrl: h.control, user: USER },
          { argv: ['cat', '/etc/passwd'], cwd: root, cols: 80, rows: 24, terminalType: 'xterm-256color' }),
        (error: unknown) => error instanceof RemotePtyError && /command not allowed/u.test(error.message),
      )
    } finally {
      await h.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a working directory outside the served roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pty-root-'))
    const h = await stack(root)
    try {
      await assert.rejects(
        openRemoteTerminal({ hubUrl: h.control, user: USER },
          { argv: SHELL, cwd: tmpdir(), cols: 80, rows: 24, terminalType: 'xterm-256color' }),
        (error: unknown) => error instanceof RemotePtyError && /cwd outside allowed roots/u.test(error.message),
      )
    } finally {
      await h.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ends the session when terminate releases the terminal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pty-root-'))
    const h = await stack(root)
    try {
      const terminal = await openRemoteTerminal({ hubUrl: h.control, user: USER },
        { argv: SHELL, cwd: root, cols: 80, rows: 24, terminalType: 'xterm-256color' })
      await terminal.write('echo before-kill\r')
      await readUntil(terminal.output, 'before-kill')
      await terminal.terminate()
      await terminal.done
      // The seam reports no shell lifecycle for a remote terminal, so nothing
      // treats a live user shell as idle.
      assert.equal((await terminal.inspectActivity()).state, 'unknown')
      assert.equal(await terminal.inspectForeground(), undefined)
      await assert.rejects(terminal.signalForeground('SIGINT'), RemotePtyError)
      await terminal.write('echo after-kill\r')
    } finally {
      await h.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
