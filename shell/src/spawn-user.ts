/**
 * Spawn one user's isolated dsh web instance.
 *
 * Provisions a per-user DSH_HOME (settings/credentials/sessions live there),
 * writes the web profile manifest with `patchReload: startup` so no inotify
 * watcher is needed, and spawns `dsh --profile web` on a caller-chosen
 * loopback port. Resolves the authenticated URL once the server prints it.
 *
 * @module dsh-team-shell/spawn-user
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Repository root; resolves the source-launch dsh CLI. */
const REPO_ROOT = new URL('../..', import.meta.url).pathname

/** Environment key selecting a user's harness home. */
const DSH_HOME_ENV = 'DSH_HOME'

/** Environment key a supervised child sees, letting it request a restart. */
export const DSH_SUPERVISED_ENV = 'DSH_SUPERVISED'

/** The marker a supervised instance writes before asking for a restart. */
export const RESTART_MARKER = '.dsh-restart-requested'

/**
 * The absolute restart-marker path for one user's web profile. A supervised
 * instance (env `DSH_SUPERVISED=1`) writes this file and then exits; the
 * supervisor sees the marker after the child exits, removes it, and spawns a
 * fresh instance on the same port.
 * @param user - the account whose profile owns the marker.
 * @param env - environment carrying `DSH_USERS_ROOT`.
 * @returns the marker path.
 */
export function restartMarkerFor(user: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(userHome(user, env), 'profiles', 'web', RESTART_MARKER)
}

/** Web profile bundles (mirrors the shipped dsh web template). */
const WEB_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

/** Base directory holding every user's DSH_HOME. */
export function usersRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_USERS_ROOT ?? join(tmpdir(), 'dsh-users')
}

/** A user's DSH_HOME path. */
export function userHome(user: string, env?: NodeJS.ProcessEnv): string {
  return join(usersRoot(env), user)
}

/** Provision a user's DSH_HOME so first boot does not auto-init with live reload. */
export function provisionUserHome(user: string, env?: NodeJS.ProcessEnv): string {
  const home = userHome(user, env)
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, JSON.stringify({
      name: `dsh-profile-${user}-web`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...WEB_BUNDLES], patchReload: 'startup' } },
    }, null, 2) + '\n')
  }
  return home
}

/** A spawned dsh web instance handle. */
export interface DshInstance {
  readonly child: ChildProcess
  readonly home: string
  readonly port: number
  /** Resolves to the authenticated URL (with token) once printed. */
  readonly url: Promise<string>
  /** Resolves when the child process exits, with its exit code. */
  readonly exited: Promise<number>
  /** Stop the instance (SIGTERM) and await exit. */
  stop(): Promise<void>
}

/** A supervised instance handle: an auto-restarting spawn loop. */
export interface SupervisedInstance {
  /** Resolves to the authenticated URL (with token) of the current generation once printed. */
  readonly url: Promise<string>
  /** Stop the loop for good: dispose the current child and never relaunch. */
  stop(): Promise<void>
}

/** Time to wait between a supervised child's exit and a relaunch, in ms. */
const RESTART_DELAY_MS = 500

/**
 * Spawn one user's dsh web instance on a loopback port.
 * `DSH_ENTRY_HOST` (the shell entry host browsers reach, e.g. the proxy's LAN
 * address) is forwarded as `--trusted-host` so the instance's browser-trust
 * fence accepts the non-loopback Host the reverse proxy forwards; spawns
 * without it stay loopback-only, matching the proxy-less single-machine form.
 * When `DSH_SUPERVISED=1` is set, the child inherits it so an in-process
 * install can request a restart by writing {@link RESTART_MARKER}.
 * @param user - account/user id whose DSH_HOME is provisioned.
 * @param port - loopback port to bind.
 * @returns the running instance handle.
 */
export function spawnUserInstance(user: string, port: number): DshInstance {
  const home = provisionUserHome(user)
  const entryHost = process.env.DSH_ENTRY_HOST
  const args = [
    '--import', 'tsx/esm', join(REPO_ROOT, 'apps/cli/src/bin.ts'),
    '--profile', 'web', '--port', String(port), '--no-open',
    ...(entryHost === undefined || entryHost === '' ? [] : ['--trusted-host', entryHost]),
  ]
  const child = spawn(
    process.execPath,
    args,
    {
      env: { ...process.env, [DSH_HOME_ENV]: home },
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let stderr = ''
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

  const url = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`dsh web for "${user}" did not announce a URL; stderr:\n${stderr}`))
    }, 30_000)
    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString()
      const match = text.match(/dsh web: (\S+)/)
      if (match?.[1]) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`dsh web for "${user}" exited early (code ${String(code)}) before announcing a URL`))
    })
  })
  const exited = new Promise<number>((resolve) => {
    child.on('exit', (code) => {
      resolve(code ?? -1)
    })
  })

  return {
    child,
    home,
    port,
    url,
    exited,
    stop: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null) { resolve(); return }
      child.once('exit', () => resolve())
      child.kill('SIGTERM')
    }),
  }
}

/**
 * Run one user's web instance under a supervision loop. The child is spawned
 * on the port; when it exits carrying {@link RESTART_MARKER} in its profile
 * (an operator install asked for a restart), the marker is removed and a fresh
 * generation is spawned after a short delay. Any other exit — a crash without
 * a marker, or an explicit {@link SupervisedInstance.stop} — ends the loop.
 * The marker protocol keeps an install-triggered restart (SIGTERM → exit 0)
 * distinguishable from a supervisor stop (also SIGTERM): only the marker
 * requests a relaunch.
 * @param user - account/user id whose DSH_HOME is provisioned.
 * @param port - loopback port to bind.
 * @returns the supervised handle, whose `url` resolves on the first generation.
 */
export function superviseUserInstance(user: string, port: number): SupervisedInstance {
  let stopRequested = false
  let current: DshInstance = spawnUserInstance(user, port)
  let generation = 0
  const url = current.url

  const loop = (async () => {
    while (!stopRequested) {
      const marker = restartMarkerFor(user)
      const code = await current.exited
      if (stopRequested) return
      if (!existsSync(marker)) {
        // A crash or a manual stop without a restart marker: end the loop.
        if (code !== 0) console.error(`[spawn-user] ${user} exited ${String(code)}; not restarting (no ${RESTART_MARKER})`)
        return
      }
      rmSync(marker)
      generation += 1
      const next = generation
      await new Promise((resolve) => { setTimeout(resolve, RESTART_DELAY_MS) })
      if (stopRequested) return
      console.log(`[spawn-user] ${user} requested a restart; spawning generation ${String(generation)}`)
      current = spawnUserInstance(user, port)
      current.url.then((u) => {
        console.log(`[spawn-user] generation ${String(next)} URL: ${u}`)
      }).catch(() => {})
    }
  })()

  return {
    url,
    stop: async () => {
      stopRequested = true
      await current.stop()
      await loop.catch(() => {})
    },
  }
}
