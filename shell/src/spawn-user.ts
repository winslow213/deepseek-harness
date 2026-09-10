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
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { injectRegionRouter, PROFILE_PATCH_FILENAME } from './remote/inject.ts'
import { accountBaseUrl, adminSecret, launchTokenFromUrl, registerInstance } from './instance-register.ts'

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

/**
 * A user's own workspace directory — the only server path the account's
 * instance may read or write (besides its mounted shadow roots). Lives under
 * DSH_HOME so each account is isolated from every other by construction.
 */
export function userWorkspace(user: string, env?: NodeJS.ProcessEnv): string {
  return join(userHome(user, env), 'workspace')
}

/** Provision a user's DSH_HOME so first boot does not auto-init with live reload. */
export function provisionUserHome(user: string, env?: NodeJS.ProcessEnv): string {
  const home = userHome(user, env)
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  // The account's own workspace is created up front so its confinement root
  // always exists and its default cwd never falls back to a shared location.
  mkdirSync(userWorkspace(user, env), { recursive: true })
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, JSON.stringify({
      name: `dsh-profile-${user}-web`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...WEB_BUNDLES], patchReload: 'startup' } },
    }, null, 2) + '\n')
  }
  writeTeamLlmPatch(home)
  writeTeamSandboxPatch(home)
  writeTeamDirectoryPickerPatch(home)
  ensureRegionRouter(user, env)
  return home
}

/** Environment key naming the hub control port (loopback), default 7100. */
const DSH_HUB_CONTROL_PORT_ENV = 'DSH_HUB_CONTROL_PORT'

/** Environment key naming the hub shadow root, default /tmp/dsh-shadow. */
const DSH_SHADOW_ROOT_ENV = 'DSH_SHADOW_ROOT'

/** Default hub control port the region routers relay to. */
const DEFAULT_HUB_CONTROL_PORT = '7100'

/** Default shadow root the region routers and mount-sync agree on. */
const DEFAULT_SHADOW_ROOT = '/tmp/dsh-shadow'

/** The loopback hub control URL the region routers relay to. */
function hubControlUrl(env: NodeJS.ProcessEnv): string {
  return `http://127.0.0.1:${env[DSH_HUB_CONTROL_PORT_ENV] ?? DEFAULT_HUB_CONTROL_PORT}`
}

/**
 * Ensure the user's profile carries the region routers + mount-sync, so every
 * paired agent root auto-registers as a workspace. This is account-provisioning
 * (not pairing-time) work: every account gets the mount surface out of the box.
 * A profile patch the operator wrote by hand (no team-shell marker) is left
 * untouched; a team-generated patch is refreshed from the current hub config.
 * @param user - the account whose profile is provisioned.
 * @param env - environment carrying `DSH_HUB_CONTROL_PORT` / `DSH_SHADOW_ROOT`.
 */
export function ensureRegionRouter(user: string, env: NodeJS.ProcessEnv = process.env): void {
  const profileDir = join(userHome(user, env), 'profiles', 'web')
  const patch = join(profileDir, PROFILE_PATCH_FILENAME)
  let exists = false
  let isOurs = false
  try {
    const text = readFileSync(patch, 'utf8')
    exists = true
    isOurs = text.includes('Injected by the team shell')
  } catch {
    exists = false
  }
  if (exists && !isOurs) return
  const runtimeSourceDir = new URL('./remote/', import.meta.url).pathname
  const workspace = userWorkspace(user, env)
  injectRegionRouter({
    runtimeSourceDir,
    hubUrl: hubControlUrl(env),
    user,
    shadowRoot: env[DSH_SHADOW_ROOT_ENV] ?? DEFAULT_SHADOW_ROOT,
    workspaceRoot: workspace,
    home: userHome(user, env),
    profileDir,
    includeShell: true,
    syncMounts: true,
    declareMounts: true,
    fsCwd: workspace,
  })
}

/** Environment key the account service reads the team API key from. */
const TEAM_LLM_API_KEY_ENV = 'TEAM_LLM_API_KEY'

/** Environment key the account service reads the team endpoint from. */
const TEAM_LLM_BASE_URL_ENV = 'TEAM_LLM_BASE_URL'

/** Credential reference (child env var) the home patch points the DeepSeek adapter at. */
const LLM_KEY_REF = 'DSH_LLM_API_KEY'

/** Environment key the home patch reads the endpoint from at startup. */
const LLM_BASE_URL_ENV = 'DSH_LLM_BASE_URL'

/** The id marking the shell-owned LLM block inside the home patch layer. */
const TEAM_LLM_PATCH_ID = 'dsh-team-llm'

/** The id marking the shell-owned sandbox block inside the home patch layer. */
const TEAM_SANDBOX_PATCH_ID = 'dsh-team-sandbox'

/** The id marking the shell-owned directory-picker block inside the home patch layer. */
const TEAM_DIRECTORY_PICKER_PATCH_ID = 'dsh-team-directory-picker'

/** The marker pair delimiting one shell-owned block inside the home patch layer. */
function teamMarkers(id: string): readonly [string, string] {
  return [`# >>> ${id}\n`, `# <<< ${id}\n`]
}

/**
 * Replace (or append) one id-delimited block inside the home-level patch
 * layer, preserving every byte outside the block. Mirrors the
 * `plugin-install` marker protocol so the shell's blocks coexist with any
 * other writer of `$DSH_HOME/cordis.patch.yml` without clobbering their rows.
 * @param patchPath - the home `cordis.patch.yml` path.
 * @param block - the full replacement text, delimited by the id's markers.
 * @param id - the marker id delimiting the block.
 */
function upsertTeamBlock(patchPath: string, block: string, id: string): void {
  let content: string
  try {
    content = readFileSync(patchPath, 'utf8')
  } catch {
    // Missing patch layer: the fresh block becomes the whole file.
    content = ''
  }
  const [start, end] = teamMarkers(id)
  const open = content.indexOf(start)
  const close = content.indexOf(end)
  const next = open >= 0 && close >= open
    ? `${content.slice(0, open)}${block}${content.slice(close + end.length)}`
    : content === ''
      ? block
      : `${content.replace(/\n*$/, '')}\n${block}`
  writeFileSync(patchPath, next, { mode: 0o600 })
}

/**
 * Upsert the home-level cordis patch steering the DeepSeek adapter to the team
 * endpoint and key reference. The key is never materialized here: the patch
 * names the `DSH_LLM_API_KEY` credential reference, resolved per request from
 * the child's inherited environment (the credentials seam's highest layer),
 * and the endpoint reads `DSH_LLM_BASE_URL` at startup through `!!js`. One
 * change to the account service environment — then an instance restart —
 * propagates new facts to every user. Any other content in the home patch
 * (e.g. operator rows) survives byte-for-byte.
 * @param home - the user's DSH_HOME.
 */
function writeTeamLlmPatch(home: string): void {
  const [start, end] = teamMarkers(TEAM_LLM_PATCH_ID)
  const body = [
    '# Team-injected LLM configuration. The API key is never written here: it',
    '# resolves per request from the inherited DSH_LLM_API_KEY environment',
    '# variable via the credentials seam, and the endpoint resolves from',
    '# DSH_LLM_BASE_URL at startup. Change the account service environment and',
    '# restart the instance to propagate new facts to every user.',
    '- id: llm-deepseek',
    "  name: '@deepseek-ai/dsh-llm-deepseek'",
    '  config:',
    `    apiKeyEnv: ${LLM_KEY_REF}`,
    `    baseURL: !!js process.env.${LLM_BASE_URL_ENV}`,
  ].join('\n')
  upsertTeamBlock(join(home, 'cordis.patch.yml'), `${start}${body}\n${end}`, TEAM_LLM_PATCH_ID)
}

/** Environment key the child reads its workspace root from (set at spawn). */
const DSH_WORKSPACE_ROOT_ENV = 'DSH_WORKSPACE_ROOT'

/**
 * Upsert the home-level patch confining the account's sandbox to its own
 * workspace: `sandbox-policy` gets `workspaceRoot` pointing at the account's
 * private directory (read via `!!js` at startup so one spawn always uses the
 * account's own path). The deployment mode stays operator-controlled through
 * `DSH_PERMISSION_MODE`, matching the base bundle's default.
 * @param home - the user's DSH_HOME.
 */
function writeTeamSandboxPatch(home: string): void {
  const [start, end] = teamMarkers(TEAM_SANDBOX_PATCH_ID)
  const body = [
    '# Team-injected workspace confinement: each account reads and writes only',
    '# inside its own workspace directory plus its mounted shadow roots.',
    '- id: sandbox-policy',
    "  name: '@deepseek-ai/dsh-sandbox-policy'",
    '  config:',
    "    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'",
    `    workspaceRoot: !!js process.env.${DSH_WORKSPACE_ROOT_ENV}`,
  ].join('\n')
  upsertTeamBlock(join(home, 'cordis.patch.yml'), `${start}${body}\n${end}`, TEAM_SANDBOX_PATCH_ID)
}

/**
 * Upsert the home-level patch confining the workspace picker to the account's
 * own directory: the adaptive `directory-picker` row is disabled (a remote
 * server has no host display for the native chooser) and the browse backend is
 * pinned with a `root` bound to the account's workspace. The root reads
 * `DSH_WORKSPACE_ROOT` via `!!js`, so one spawn always uses the account's own
 * path — and the backend refuses to list or create any directory outside it.
 * @param home - the user's DSH_HOME.
 */
function writeTeamDirectoryPickerPatch(home: string): void {
  const [start, end] = teamMarkers(TEAM_DIRECTORY_PICKER_PATCH_ID)
  const body = [
    '# Team-injected workspace picker confinement: pin the browse interaction',
    '# and confine it to the account\'s own workspace, so a member can only',
    '# pick or create directories inside their own root.',
    '- id: directory-picker',
    '  disabled: true',
    '- insert:',
    '    - id: directory-picker-browse',
    "      name: '@deepseek-ai/dsh-host-directory-picker-browse'",
    '      config:',
    `        root: !!js process.env.${DSH_WORKSPACE_ROOT_ENV}`,
    '    - id: directory-picker-browse-ui',
    "      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'",
  ].join('\n')
  upsertTeamBlock(join(home, 'cordis.patch.yml'), `${start}${body}\n${end}`, TEAM_DIRECTORY_PICKER_PATCH_ID)
}

/**
 * Build the child environment for a spawned instance, layering the team-wide
 * facts over the inherited environment:
 *
 * - `DSH_LLM_API_KEY` / `DSH_LLM_BASE_URL` (from `TEAM_LLM_API_KEY` /
 *   `TEAM_LLM_BASE_URL`) under the reference names the home patch reads.
 * - `DSH_PLUGIN_INSTALL` (from `TEAM_PLUGIN_INSTALL`, default `true`), the
 *   operator switch that mounts the plugin-install host + settings UI rows.
 *
 * Omitted facts stay omitted so each surface falls back to its own default.
 * @param home - the user's DSH_HOME (set as `DSH_HOME`).
 * @param supervised - when true, set `DSH_SUPERVISED=1` so an in-process
 *   plugin install can request a supervisor restart via the marker.
 * @returns the child process environment.
 */
function teamChildEnv(home: string, supervised: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, [DSH_HOME_ENV]: home }
  const apiKey = process.env[TEAM_LLM_API_KEY_ENV]
  const baseUrl = process.env[TEAM_LLM_BASE_URL_ENV]
  if (apiKey !== undefined && apiKey !== '') env[LLM_KEY_REF] = apiKey
  if (baseUrl !== undefined && baseUrl !== '') env[LLM_BASE_URL_ENV] = baseUrl
  // Plugin install is account-provisioning surface, not a per-deployment opt
  // out: every member can install into their own profile. The operator can
  // still set TEAM_PLUGIN_INSTALL=false to turn it off fleet-wide.
  env.DSH_PLUGIN_INSTALL = process.env.TEAM_PLUGIN_INSTALL ?? 'true'
  // The account's private workspace is the sandbox confinement root.
  env[DSH_WORKSPACE_ROOT_ENV] = join(home, 'workspace')
  if (supervised) env[DSH_SUPERVISED_ENV] = '1'
  return env
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
  /** The child process of the current generation (the supervisor swaps it on restart). */
  readonly child: ChildProcess
  /** The loopback port every generation binds (fixed for the supervision's lifetime). */
  readonly port: number
  /** Resolves when the supervision loop ends for good (stop, or a non-marker crash). */
  readonly exited: Promise<void>
  /** Stop the loop for good: dispose the current child and never relaunch. */
  stop(): Promise<void>
}

/** Per-generation registration hook for {@link superviseUserInstance}. */
export type SuperviseOnReady = (user: string, port: number, instance: DshInstance) => void | Promise<void>

/** Time to wait between a supervised child's exit and a relaunch, in ms. */
const RESTART_DELAY_MS = 500

/**
 * Spawn one user's dsh web instance on a loopback port.
 * `DSH_ENTRY_HOST` (the shell entry host browsers reach, e.g. the proxy's LAN
 * address) is forwarded as `--trusted-host` so the instance's browser-trust
 * fence accepts the non-loopback Host the reverse proxy forwards; spawns
 * without it stay loopback-only, matching the proxy-less single-machine form.
 * When `supervised` is true, `DSH_SUPERVISED=1` is set on the child so an
 * in-process install can request a restart by writing {@link RESTART_MARKER}.
 * @param user - account/user id whose DSH_HOME is provisioned.
 * @param port - loopback port to bind.
 * @param supervised - whether a supervisor loop will relaunch the child
 *   (`DSH_SUPERVISED=1`), enabling the plugin-install self-restart marker.
 * @returns the running instance handle.
 */
export function spawnUserInstance(user: string, port: number, supervised = false): DshInstance {
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
      env: teamChildEnv(home, supervised),
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
 * Register one generation's loopback port and launch token with the team
 * account service once its URL is announced. Best-effort: no account layer is
 * configured (TEAM_ACCOUNT_URL unset) the spawn still works in the static form.
 * @param user - the account whose instance registers.
 * @param port - the loopback port the instance listens on.
 * @param instance - a handle whose `url` resolves to the authenticated URL.
 */
export async function registerOnReady(user: string, port: number, instance: { url: Promise<string> }): Promise<void> {
  const account = accountBaseUrl()
  if (account === undefined) return
  try {
    const url = await instance.url
    const token = launchTokenFromUrl(url)
    const ok = await registerInstance(account, user, port, {
      launchToken: token,
      secret: adminSecret(),
    })
    console.log(`[spawn-user] instance registration for ${user}:${String(port)} ${ok ? 'ok' : 'FAILED'}`)
  } catch (error) {
    console.error(`[spawn-user] registration skipped: ${error instanceof Error ? error.message : String(error)}`)
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
 * @param options - registration hook for each generation; defaults to the
 *   account-service HTTP registration used by the standalone `spawn-user` CLI.
 * @returns the supervised handle, whose `url` resolves on the first generation.
 */
export function superviseUserInstance(user: string, port: number, options: { onReady?: SuperviseOnReady } = {}): SupervisedInstance {
  const onReady = options.onReady ?? registerOnReady
  let stopRequested = false
  let current: DshInstance = spawnUserInstance(user, port, true)
  let generation = 0
  const url = current.url
  void onReady(user, port, current)

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
      current = spawnUserInstance(user, port, true)
      void onReady(user, port, current)
      current.url.then((u) => {
        console.log(`[spawn-user] generation ${String(next)} URL: ${u}`)
      }).catch(() => {})
    }
  })()

  return {
    url,
    child: current.child,
    port,
    exited: loop.then(() => {}),
    stop: async () => {
      stopRequested = true
      await current.stop()
      await loop.catch(() => {})
    },
  }
}
