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
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Repository root; resolves the source-launch dsh CLI. */
const REPO_ROOT = new URL('../..', import.meta.url).pathname

/** Environment key selecting a user's harness home. */
const DSH_HOME_ENV = 'DSH_HOME'

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
  /** Stop the instance (SIGTERM) and await exit. */
  dispose(): Promise<void>
}

/**
 * Spawn one user's dsh web instance on a loopback port.
 * @param user - account/user id whose DSH_HOME is provisioned.
 * @param port - loopback port to bind.
 * @returns the running instance handle.
 */
export function spawnUserInstance(user: string, port: number): DshInstance {
  const home = provisionUserHome(user)
  const child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', join(REPO_ROOT, 'apps/cli/src/bin.ts'), '--profile', 'web', '--port', String(port), '--no-open'],
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
      reject(new Error(`dsh web for "${user}" exited early (code ${String(code)}); stderr:\n${stderr}`))
    })
  })

  return {
    child,
    home,
    port,
    url,
    dispose: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null) { resolve(); return }
      child.once('exit', () => resolve())
      child.kill('SIGTERM')
    }),
  }
}
