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

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { injectRegionRouter, injectUserWiki, injectKbSearch, PROFILE_PATCH_FILENAME } from './remote/inject.ts'
import { parseSharedRoots, resolveSharedRoots, type ResolvedSharedRoots } from './shared-roots.ts'
import { scaffoldUserWiki, readWikiLayer } from './remote/wiki-fs.ts'
import { seedBaselineIfMissing } from './remote/oplog.ts'
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

/**
 * npm specs the team pins for every account's web profile — installed the
 * same way `dsh plugin --profile web add <spec>` would, so a mandatory
 * plugin's `dependencies` entry and `dsh.profile.bundles` row are
 * indistinguishable from one a member chose themselves.
 *
 * These target the 0.1.x runtime. A deployment on a runtime whose peer ranges
 * the plugins do not cover sets `TEAM_MANDATORY_BUNDLES` to the empty string
 * rather than let every provision retry an install the plugin manager
 * rejects.
 */
const MANDATORY_BUNDLE_SPECS: Readonly<Record<string, string>> = {
  '@xmanrui/dsh-im': '4.20.2',
  '@nanmicoder/dsh-agent-teams': '^0.1.18',
}

/**
 * Resolve the specs to install from `TEAM_MANDATORY_BUNDLES`, a
 * comma-separated `name@version` sequence.
 *
 * Unset keeps the built-in pins. Set — including to the empty string — is
 * authoritative, so a deployment can run without any pinned bundle. Entries
 * without a version, such as a bare scoped name, are dropped rather than
 * guessed at: an unpinned install is a different deployment decision.
 *
 * @param raw - the raw `TEAM_MANDATORY_BUNDLES` value, or undefined.
 * @returns the name-to-spec mapping to reconcile.
 */
export function parseMandatoryBundles(raw: string | undefined): Record<string, string> {
  if (raw === undefined) return { ...MANDATORY_BUNDLE_SPECS }
  const specs: Record<string, string> = {}
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim()
    const at = trimmed.lastIndexOf('@')
    if (at <= 0 || at === trimmed.length - 1) continue
    specs[trimmed.slice(0, at)] = trimmed.slice(at + 1)
  }
  return specs
}

/** Base directory holding every user's DSH_HOME. */
export function usersRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_USERS_ROOT ?? join(tmpdir(), 'dsh-users')
}

/** A user's DSH_HOME path. */
export function userHome(user: string, env?: NodeJS.ProcessEnv): string {
  return join(usersRoot(env), user)
}

/**
 * Whether one IM integration directory has a bot bound to it.
 *
 * `@xmanrui/dsh-im` keeps two files per channel under `integrations/<channel>/`:
 * `config.json` records the bots the member registered, and `workspaces.json`
 * maps each bot to the workspace it answers for. Either one carrying an entry
 * means the account has a bot, so both count — `config.json` alone covers a
 * bot registered in a session that then ended, and `workspaces.json` alone
 * covers one whose config uses a layout this check does not recognize.
 *
 * The bot list is found by looking for any top-level non-empty array of
 * objects rather than by naming the field (`bots` on feishu, `accounts` on
 * weixin), because each channel declares its own config type or none at all.
 * @param dir - the integration directory, e.g. `<home>/integrations/dsh-feishu`.
 * @returns true when at least one bot is recorded.
 */
function integrationHasBot(dir: string): boolean {
  for (const filename of ['config.json', 'workspaces.json']) {
    let doc: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, filename), 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      doc = parsed as Record<string, unknown>
    } catch {
      continue // Absent or unreadable: this file cannot evidence a bot.
    }
    for (const [key, value] of Object.entries(doc)) {
      if (key === 'version') continue
      // Mappings are the bound-bot set; arrays are the registered-bot list.
      if (Array.isArray(value) ? value.length > 0 : isBotMap(value)) return true
    }
  }
  return false
}

/** Whether a value is a non-empty `botId -> workspace` mapping. */
function isBotMap(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entries = Object.entries(value as Record<string, unknown>)
  return entries.length > 0 && entries.every(([, target]) => typeof target === 'string')
}

/**
 * Every account with an IM bot bound to it, by account id.
 *
 * An account in this set has a live reason to keep an instance running: the
 * bot reaches its agent only through that instance, so an instance that is
 * gone is a bot that silently stops answering. The set is read from disk
 * rather than from the database because the bot binding is owned by the IM
 * plugin, which has no row in the account service's schema.
 * @param env - environment carrying `DSH_USERS_ROOT`.
 * @returns account ids with at least one bound bot, sorted for stable ordering.
 */
export function listBotConnectedUsers(env: NodeJS.ProcessEnv = process.env): string[] {
  let users: string[]
  try {
    users = readdirSync(usersRoot(env), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return [] // No users root yet.
  }
  const connected = users.filter(user => {
    const integrations = join(userHome(user, env), 'integrations')
    let channels: string[]
    try {
      channels = readdirSync(integrations, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      return false // No integrations installed.
    }
    return channels.some(channel => integrationHasBot(join(integrations, channel)))
  })
  return connected.sort()
}

/**
 * A user's own workspace directory — the only server path the account's
 * instance may read or write (besides its mounted shadow roots). Lives under
 * DSH_HOME so each account is isolated from every other by construction.
 */
export function userWorkspace(user: string, env?: NodeJS.ProcessEnv): string {
  return join(userHome(user, env), 'workspace')
}

/**
 * The account facts a spawn needs from the account store. Both are asynchronous
 * to read and synchronous to use, so the caller resolves them once and passes
 * them down rather than the provisioning path querying mid-spawn.
 */
export interface SpawnAccountFacts {
  /** The account's own KB agent token; omitted falls back to the shared one. */
  agentToken?: string
  /** The account's `dsh_users.role`, selecting its shared directories. */
  role?: string
}

/**
 * Provision a user's DSH_HOME so first boot does not auto-init with live reload.
 * @param user - the account whose home is provisioned.
 * @param env - environment carrying `DSH_USERS_ROOT` and the team config values.
 * @param account - the account's own facts, resolved by the caller that owns
 *   the account store. An omitted token falls back to the shared
 *   `TEAM_KB_AGENT_TOKEN` (or to no token at all); an omitted role grants no
 *   shared directory, which is also what a deployment without a
 *   `TEAM_SHARED_ROOTS` mapping gets.
 */
export function provisionUserHome(user: string, env?: NodeJS.ProcessEnv, account: SpawnAccountFacts = {}): string {
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
  ensureRegionRouter(user, env, account.role)
  ensureUserWiki(user, env)
  ensureKbSearch(user, env, account.agentToken)
  ensureMandatoryBundles(user, env)
  ensureImWorkspacePatch(user, env)
  ensureImWorkspaceDefault(user, env)
  return home
}

/**
 * Ensure every account's web profile has the team's mandatory plugins
 * installed, via the same `dsh plugin --profile web add <spec>` path a
 * member would use themselves — `pnpm add` in the profile directory, then a
 * `dsh.profile.bundles` reconcile against the installed state. Skips the
 * pnpm run entirely once every pinned spec already matches the profile's
 * `dependencies` entry, which is the common case on every restart after the
 * first. Runs on every `provisionUserHome` call, so an existing account
 * catches up on its next restart and a new account gets it from creation.
 * A failed install is logged and left for the next restart to retry — a
 * member's login must not block on a registry hiccup.
 * @param user - the account whose profile is provisioned.
 * @param env - environment carrying `DSH_USERS_ROOT` and the optional
 *   `TEAM_MANDATORY_BUNDLES` override resolved by
 *   {@link parseMandatoryBundles}.
 */
export function ensureMandatoryBundles(user: string, env: NodeJS.ProcessEnv = process.env): void {
  const home = userHome(user, env)
  const manifestPath = join(home, 'profiles', 'web', 'package.json')
  let manifest: { dependencies?: Record<string, string> }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return // provisionUserHome always writes this manifest first; a missing/corrupt file is a different problem.
  }
  const deps = manifest.dependencies ?? {}
  const specs = parseMandatoryBundles(env.TEAM_MANDATORY_BUNDLES)
  const missing = Object.entries(specs).filter(([name, version]) => deps[name] !== version)
  if (missing.length === 0) return
  const requested = missing.map(([name, version]) => `${name}@${version}`)
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', join(REPO_ROOT, 'apps/cli/src/bin.ts'), 'plugin', '--profile', 'web', 'add', ...requested],
    { env: { ...process.env, [DSH_HOME_ENV]: home }, cwd: REPO_ROOT, stdio: 'pipe' },
  )
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? String(result.error ?? '')
    process.stderr.write(`dsh-team-shell: mandatory bundle install failed for "${user}": ${stderr}\n`)
  }
}

/**
 * Ensure every IM integration's bot-to-workspace mapping points at the
 * account's own workspace, never the shared repo root. `@xmanrui/dsh-im`
 * defaults an unmapped bot's workspace to `process.cwd()`, and every
 * instance's cwd is the shared {@link REPO_ROOT} — so a bot's first
 * connection on any channel silently maps it to the whole repository unless
 * `workspaces.json` already names the account's own workspace. Runs on every
 * `provisionUserHome` call so a bot connected before this fix existed
 * self-heals on the account's next restart.
 * @param user - the account whose integrations are provisioned.
 * @param env - environment carrying `DSH_USERS_ROOT`.
 */
export function ensureImWorkspaceDefault(user: string, env: NodeJS.ProcessEnv = process.env): void {
  const integrationsDir = join(userHome(user, env), 'integrations')
  let entries: string[]
  try {
    entries = readdirSync(integrationsDir)
  } catch {
    return // No integrations installed yet.
  }
  const workspace = userWorkspace(user, env)
  const wrongDefault = REPO_ROOT.replace(/\/$/, '')
  for (const entry of entries) {
    const workspacesPath = join(integrationsDir, entry, 'workspaces.json')
    let doc: { workspaces?: Record<string, string> }
    try {
      doc = JSON.parse(readFileSync(workspacesPath, 'utf8'))
    } catch {
      continue // No workspaces.json for this integration, or unreadable.
    }
    const workspaces = doc.workspaces
    if (workspaces === undefined) continue
    let changed = false
    for (const [botId, mappedPath] of Object.entries(workspaces)) {
      if (mappedPath === wrongDefault) {
        workspaces[botId] = workspace
        changed = true
      }
    }
    if (changed) writeFileSync(workspacesPath, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
  }
}

/** The id `@xmanrui/dsh-im` inserts itself under; the home patch targets it. */
const IM_PLUGIN_ID = 'xmanrui-dsh-im'

/** The IM plugin's package name, used to detect that its config row will exist. */
const IM_PLUGIN_PACKAGE = '@xmanrui/dsh-im'

/**
 * Every `@xmanrui/dsh-im` channel whose runtime resolves its default workspace
 * from `config.workspace ?? process.cwd()`. The keys are the plugin's own
 * channel names (note `wecomApp` is camelCase); telegram, discord, and
 * imessage are listed because each delegates its runtime to the shared
 * controller, which reads the same key.
 */
const IM_WORKSPACE_CHANNELS = [
  'feishu', 'weixin', 'dingtalk', 'wecom', 'wecomApp',
  'qq', 'slack', 'telegram', 'discord', 'whatsapp', 'imessage',
] as const

/** The id marking the shell-owned IM-workspace block inside the home patch layer. */
const TEAM_IM_WORKSPACE_PATCH_ID = 'dsh-team-im-workspace'

/**
 * Upsert the home-level patch pointing every `@xmanrui/dsh-im` channel's
 * `workspace` at the account's own workspace.
 *
 * Without this, each channel defaults an unmapped bot's workspace to
 * `process.cwd()`, and every instance's cwd is the shared repository root —
 * so a bot's first connection on any channel silently maps itself to the
 * whole repo (the failure reported from Feishu). Setting the config fixes it
 * at the source: a bot registered mid-session gets the right default
 * immediately, with no file rewrite and no restart.
 *
 * `ensureImWorkspaceDefault` still runs alongside this: config decides what a
 * NEW bot records, while the data rewrite corrects bots that already recorded
 * the wrong path before this patch existed. Neither alone covers both.
 *
 * Only written when the plugin is actually installed — an id-targeted patch
 * naming an absent row would be misconfiguration, and the plugin is installed
 * by `ensureMandatoryBundles`, which runs just before this.
 * @param user - the account whose home patch is provisioned.
 * @param env - environment carrying `DSH_USERS_ROOT`.
 */
export function ensureImWorkspacePatch(user: string, env: NodeJS.ProcessEnv = process.env): void {
  const home = userHome(user, env)
  const installed = join(home, 'profiles', 'web', 'node_modules', ...IM_PLUGIN_PACKAGE.split('/'))
  if (!existsSync(installed)) return
  const [start, end] = teamMarkers(TEAM_IM_WORKSPACE_PATCH_ID)
  const body = [
    '# Team-injected IM workspace default: every @xmanrui/dsh-im channel',
    "# resolves an unmapped bot's workspace from its own config before falling",
    '# back to process.cwd() (the shared repo root), so pin it to the account.',
    `- id: ${IM_PLUGIN_ID}`,
    '  config:',
    ...IM_WORKSPACE_CHANNELS.flatMap(channel => [
      `    ${channel}:`,
      `      workspace: !!js process.env.${DSH_WORKSPACE_ROOT_ENV}`,
    ]),
  ].join('\n')
  upsertTeamBlock(join(home, 'cordis.patch.yml'), `${start}${body}\n${end}`, TEAM_IM_WORKSPACE_PATCH_ID)
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
export function ensureRegionRouter(user: string, env: NodeJS.ProcessEnv = process.env, role?: string): void {
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
    readableRoots: sharedRootsFor(role, env).readable,
    profileDir,
    includeShell: true,
    syncMounts: true,
    declareMounts: true,
    fsCwd: workspace,
  })
}

/** The id marking the shell-owned personal-wiki block inside the home patch layer. */
const TEAM_USER_WIKI_PATCH_ID = 'dsh-team-user-wiki'

/**
 * Ensure the user's home patch carries the `wiki_note` tool and points
 * `agent-instructions` at the identity/preferences layer files, and that the
 * four wiki layer files exist under the account's workspace. Runs on every
 * `provisionUserHome` call (idempotent: scaffolding never overwrites an
 * existing file, and the patch block is upserted), so the wiki is always in
 * place by the user's first turn — not just at true first-instance creation.
 * @param user - the account whose home/workspace is provisioned.
 * @param env - environment carrying `DSH_USERS_ROOT`.
 */
export function ensureUserWiki(user: string, env: NodeJS.ProcessEnv = process.env): void {
  const home = userHome(user, env)
  const workspace = userWorkspace(user, env)
  scaffoldUserWiki(workspace)
  // Every account, new or pre-existing, gets its baseline op seeded here: the
  // skeleton text this just scaffolded is itself non-empty content, and the
  // merge fail-safe cannot distinguish "scaffolded but never written to" from
  // "op history was lost". Seeding at provisioning keeps both off that path.
  seedBaselineIfMissing(workspace, layer => readWikiLayer(workspace, layer))
  const runtimeSourceDir = new URL('./remote/', import.meta.url).pathname
  const block = injectUserWiki({ runtimeSourceDir, home, workspaceRoot: workspace })
  const [start, end] = teamMarkers(TEAM_USER_WIKI_PATCH_ID)
  upsertTeamBlock(join(home, 'cordis.patch.yml'), `${start}${block}\n${end}`, TEAM_USER_WIKI_PATCH_ID)
}

/** Environment key naming the team KB agent server's base URL. */
const TEAM_KB_BASE_URL_ENV = 'TEAM_KB_BASE_URL'

/**
 * Environment key holding the agent token the KB server accepts as a read-only
 * service credential. The KB server gates content writes behind a caller but
 * treats opening a session and asking a question as a reader's handshake, so a
 * service token is accepted for those two calls. Without it those calls answer
 * 401 and the `kb_search` tool cannot reach the knowledge base.
 */
const TEAM_KB_AGENT_TOKEN_ENV = 'TEAM_KB_AGENT_TOKEN'

/** Default team KB agent server base URL (same host, loopback). */
const DEFAULT_TEAM_KB_BASE_URL = 'http://127.0.0.1:8080'

/** The id marking the shell-owned kb_search block inside the home patch layer. */
const TEAM_KB_SEARCH_PATCH_ID = 'dsh-team-kb-search'

/**
 * Ensure the user's home patch carries the `kb_search` tool, pointed at the
 * team's KB agent server. Runs on every `provisionUserHome` call (idempotent:
 * the patch block is upserted), so the tool is in place by the user's first
 * turn.
 * The KB server binds `POST /api/sessions` to the calling account, so each home
 * must carry **that account's own** token: a token shared by every account
 * would let one account's agent declare another's `user_id`, which is exactly
 * the attribution the account token proves. `TEAM_KB_AGENT_TOKEN` remains a
 * deployment-wide fallback for callers with no account store to read.
 * @param user - the account whose home is provisioned; also the KB session's `user_id`.
 * @param env - environment carrying `DSH_USERS_ROOT` / `TEAM_KB_BASE_URL` and the fallback token.
 * @param kbAgentToken - the account's own token, when the caller resolved one.
 */
export function ensureKbSearch(user: string, env: NodeJS.ProcessEnv = process.env, kbAgentToken?: string): void {
  const home = userHome(user, env)
  const runtimeSourceDir = new URL('./remote/', import.meta.url).pathname
  const kbBaseUrl = env[TEAM_KB_BASE_URL_ENV] ?? DEFAULT_TEAM_KB_BASE_URL
  const agentToken = kbAgentToken ?? env[TEAM_KB_AGENT_TOKEN_ENV]
  const block = injectKbSearch({ runtimeSourceDir, home, userId: user, kbBaseUrl, agentToken })
  const [start, end] = teamMarkers(TEAM_KB_SEARCH_PATCH_ID)
  upsertTeamBlock(join(home, 'cordis.patch.yml'), `${start}${block}\n${end}`, TEAM_KB_SEARCH_PATCH_ID)
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
 * The model catalog every account's profile exposes.
 *
 * The team endpoint serves more than the upstream default advertises, and
 * upstream's default has shrunk across releases — the 0.2.1-alpha.2 catalog
 * carries only Flash and Pro, dropping the vision model accounts had before.
 * Pinning the list here keeps members' model picker stable across those
 * upstream default changes. Entries mirror `DEFAULT_MODELS` in
 * `packages/llm/llm-deepseek/src/models.ts`; `inputModalities` must include
 * `image` for a model that accepts images.
 */
const TEAM_MODELS: readonly { id: string; name: string; description?: string; vision: boolean }[] = [
  { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', vision: true },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
    vision: false,
  },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp', vision: true },
]

/** Default context capacity both the upstream catalog and the team endpoint report. */
const TEAM_MODEL_CONTEXT_WINDOW = 1_000_000

/** Render {@link TEAM_MODELS} as the `models:` sequence of the LLM patch block. */
function renderTeamModels(): string[] {
  const lines = ['    models:']
  for (const model of TEAM_MODELS) {
    lines.push(`      - id: ${model.id}`)
    lines.push(`        name: ${model.name}`)
    if (model.description !== undefined) lines.push(`        description: ${model.description}`)
    lines.push(`        contextWindow: ${String(TEAM_MODEL_CONTEXT_WINDOW)}`)
    // Flash keeps the upstream cache-compatibility flags: the endpoint accepts
    // tool definitions only by addition, and rewrites of the system prompt
    // belong in history.
    if (model.vision) lines.push('        inputModalities: [text, image]')
    if (model.id === 'deepseek-flash') {
      lines.push('        systemPromptUpdate: in-history')
      lines.push('        toolUpdate: addition-only')
    }
  }
  return lines
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
    "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
    '  config:',
    `    apiKeyEnv: ${LLM_KEY_REF}`,
    `    baseURL: !!js process.env.${LLM_BASE_URL_ENV}`,
    ...renderTeamModels(),
  ].join('\n')
  upsertTeamBlock(join(home, 'cordis.patch.yml'), `${start}${body}\n${end}`, TEAM_LLM_PATCH_ID)
}

/** Environment key the child reads its workspace root from (set at spawn). */
const DSH_WORKSPACE_ROOT_ENV = 'DSH_WORKSPACE_ROOT'

/** Environment key the child reads the shared per-account root from (set at spawn). */
const DSH_USERS_ROOT_ENV = 'DSH_USERS_ROOT'

/** Environment key the child reads its extra writable roots from (set at spawn). */
const DSH_RW_ROOTS_ENV = 'DSH_RW_ROOTS'

/** Environment key the child reads its extra readable roots from (set at spawn). */
const DSH_READ_ALLOWED_ROOTS_ENV = 'DSH_READ_ALLOWED_ROOTS'

/** Environment key the deployment configures the shared-root mapping through. */
const TEAM_SHARED_ROOTS_ENV = 'TEAM_SHARED_ROOTS'

/** Role an account without an explicit `dsh_users.role` is treated as. */
const DEFAULT_ROLE = 'member'

/**
 * The shared roots one account is granted, from the deployment's mapping, the
 * account's role, and this host's users and shadow roots.
 *
 * The shadow root is needed here — not only in the enforcement layer — because
 * a grant that contains it would be bound over the sandbox's ephemeral temp
 * mount and expose every account's shadow directory. Only this layer knows
 * where the shadow root is.
 * @param role - the account's `dsh_users.role`, or undefined when unknown.
 * @param env - environment carrying `DSH_USERS_ROOT`, `DSH_SHADOW_ROOT`, and
 *   the `TEAM_SHARED_ROOTS` mapping.
 * @returns the account's writable and readable shared roots.
 */
export function sharedRootsFor(role: string | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedSharedRoots {
  const entries = parseSharedRoots(
    env[TEAM_SHARED_ROOTS_ENV],
    usersRoot(env),
    env[DSH_SHADOW_ROOT_ENV] ?? DEFAULT_SHADOW_ROOT,
  )
  return resolveSharedRoots(entries, role ?? DEFAULT_ROLE)
}

/**
 * Upsert the home-level patch confining the account's sandbox to its own
 * workspace: `sandbox-policy` gets `workspaceRoot` pointing at the account's
 * private directory (read via `!!js` at startup so one spawn always uses the
 * account's own path). The deployment mode stays operator-controlled through
 * `DSH_PERMISSION_MODE`, matching the base bundle's default.
 *
 * The same block carries the read shield. Workspace confinement only bounds
 * what a command may MODIFY: without the shield every account's confined shell
 * can still `cat` the other accounts' homes under the users root (their
 * `.credentials.yaml` included). Denying that root and re-exposing this
 * account's own home keeps its tooling working while hiding its siblings. Both
 * sides are read from the environment at startup, so nothing about another
 * account's layout is baked into this file.
 *
 * The same block carries the deployment's shared directories: `rwRoots` grants
 * them writable, and `readAllowedRoots` re-exposes them, which the sandbox's
 * read shield requires because the shared directory lives inside the denied
 * users root. Both lists are per account — the role decided them — and both
 * arrive whole through the environment, so neither expression nests quotes
 * inside the YAML scalar.
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
    '# Read isolation between accounts sharing this host: hide every sibling',
    "# account's home, then re-expose this account's own home plus the shared",
    '# directories its role granted.',
    // Quoted: an unquoted `!!js [` value parses as a YAML flow sequence, and
    // the trailing `.filter(...)` then fails the whole patch, which stops the
    // account from booting rather than merely skipping the shield.
    `    readDeniedRoots: !!js '[process.env.${DSH_USERS_ROOT_ENV}].filter(Boolean)'`,
    `    readAllowedRoots: !!js JSON.parse(process.env.${DSH_READ_ALLOWED_ROOTS_ENV} ?? '[]')`,
    '# Shared directories this account may write, resolved from its role.',
    `    rwRoots: !!js JSON.parse(process.env.${DSH_RW_ROOTS_ENV} ?? '[]')`,
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
 * @param role - the account's `dsh_users.role`, selecting its shared roots.
 *   Omitted (an unknown account) resolves to no grant, which is also what the
 *   deployment gets without a `TEAM_SHARED_ROOTS` mapping.
 * @param source - the parent environment this child inherits from.
 * @returns the child process environment.
 */
export function teamChildEnv(
  home: string,
  supervised: boolean,
  role?: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, [DSH_HOME_ENV]: home }
  const apiKey = source[TEAM_LLM_API_KEY_ENV]
  const baseUrl = source[TEAM_LLM_BASE_URL_ENV]
  if (apiKey !== undefined && apiKey !== '') env[LLM_KEY_REF] = apiKey
  if (baseUrl !== undefined && baseUrl !== '') env[LLM_BASE_URL_ENV] = baseUrl
  // Plugin install is account-provisioning surface, not a per-deployment opt
  // out: every member can install into their own profile. The operator can
  // still set TEAM_PLUGIN_INSTALL=false to turn it off fleet-wide.
  env.DSH_PLUGIN_INSTALL = source.TEAM_PLUGIN_INSTALL ?? 'true'
  // The account's private workspace is the sandbox confinement root.
  env[DSH_WORKSPACE_ROOT_ENV] = join(home, 'workspace')
  // The shared users root every account home sits under is the read-shield
  // boundary; the parent of this account's home is exactly that, whatever the
  // operator chose to call it.
  env[DSH_USERS_ROOT_ENV] = source[DSH_USERS_ROOT_ENV] ?? dirname(home)
  // The read shield below hides the users root, so the re-exposure list is the
  // account's own home plus the shared directories its role granted — the
  // writable ones included, because a grant the sandbox may write must also
  // stay readable.
  const shared = sharedRootsFor(role, source)
  env[DSH_RW_ROOTS_ENV] = JSON.stringify(shared.writable)
  env[DSH_READ_ALLOWED_ROOTS_ENV] = JSON.stringify([home, ...shared.readable])
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
 * @param kbAgentToken - the account's own KB agent token, or undefined to use
 *   the shared fallback from the environment.
 * @returns the running instance handle.
 */
export function spawnUserInstance(user: string, port: number, options: SpawnAccountFacts & { supervised?: boolean } = {}): DshInstance {
  const home = provisionUserHome(user, process.env, options)
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
      env: teamChildEnv(home, options.supervised ?? false, options.role),
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  // Bounded: enough to explain a failure, never enough to grow without limit
  // over a long-lived instance's lifetime.
  const STDERR_KEEP_BYTES = 8192
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-STDERR_KEEP_BYTES)
  })
  // Surface the child's last words when it exits unexpectedly. Without this the
  // reason an instance vanished was unknowable: the buffer was only ever
  // printed on a startup timeout, so a clean-looking exit left no trace.
  child.on('exit', (code, signal) => {
    const how = signal === null ? `exited ${String(code)}` : `killed by ${signal}`
    const detail = stderr.trim() === '' ? ' (no output)' : `\n${stderr.trim()}`
    // Signal 0 / code 0 is an ordinary stop (logout, explicit stop): routine.
    const expected = signal === null && code === 0
    const line = `[spawn-user] ${user} ${how} on port ${String(port)}${detail}`
    if (expected) console.log(line)
    else console.error(line)
  })

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
 *   `agentToken` is the account's own KB agent token, re-applied to every
 *   generation.
 * @returns the supervised handle, whose `url` resolves on the first generation.
 */
export function superviseUserInstance(user: string, port: number, options: SpawnAccountFacts & { onReady?: SuperviseOnReady } = {}): SupervisedInstance {
  const onReady = options.onReady ?? registerOnReady
  let stopRequested = false
  let current: DshInstance = spawnUserInstance(user, port, { supervised: true, ...options })
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
      current = spawnUserInstance(user, port, { supervised: true, ...options })
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
