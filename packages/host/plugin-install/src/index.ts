/**
 * Operator-gated WebUI plugin install gateway: the running dsh web instance
 * installs external plugins into its own profile directory over the Remote
 * namespace. The service mounts only when Config `enabled` is true; the
 * web-app composition gates the whole mount on the operator switch, so a
 * default deployment never loads this package.
 * @module @deepseek-ai/dsh-host-plugin-install
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dump } from 'js-yaml'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the install surface reads `ctx.loader.entries()` to self-locate
// the running instance's profile directory.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import {
  DEFAULT_PROFILE_BUNDLES,
  initProfile,
  PROFILE_PATCH_FILENAME,
  readProfileManifest,
  reconcileProfileBundles,
} from '@deepseek-ai/dsh-app-boot'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type {
  Config,
  DirectoryUploadFile,
  FileDirInstallSpec,
  NpmBundleInstallSpec,
  NpmRegisterInstallSpec,
  PluginInstallResult,
  PluginInstallSpec,
  UploadDirectorySpec,
} from './types.ts'

export type * from './types.ts'

/** Diagnostic prefix on manifest and reconcile errors. */
const NAME = 'plugin-install'

/** The profile-private directory holding file-dir plugin copies. */
const PLUGINS_DIR = 'plugins'

/** The loose-plugin manifest written when a copied directory ships none. */
const LOOSE_PLUGIN_MANIFEST = { type: 'module' } as const

/** A plugin id must be one path-safe segment, so it can never escape `plugins/`. */
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * The restart-marker filename a supervised instance writes before exiting so
 * its supervisor (shell's spawn-user loop) relaunches it on the same port.
 * Kept in sync with `RESTART_MARKER` in shell/src/spawn-user.ts — the shell is
 * a standalone tree that cannot import from packages, so the name is a shared
 * literal protocol between the two.
 */
export const RESTART_MARKER = '.dsh-restart-requested'

/** Environment variable a supervisor sets so the instance knows it may restart. */
export const DSH_SUPERVISED_ENV = 'DSH_SUPERVISED'

/** How long to wait after a successful install before self-exiting, so the Remote response reaches the browser first. */
const RESTART_GRACE_MS = 800

/**
 * Directory-upload ceilings. Security invariants, not tunables: they bound
 * how much operator-triggered base64 a running instance decodes and writes.
 */
const MAX_UPLOAD_FILES = 512
const MAX_UPLOAD_FILE_BYTES = 1024 * 1024
const MAX_UPLOAD_TOTAL_BYTES = 10 * 1024 * 1024
/** The base64 length of a `MAX_UPLOAD_FILE_BYTES` payload, plus `=` padding. */
const MAX_UPLOAD_FILE_BASE64 = Math.ceil((MAX_UPLOAD_FILE_BYTES * 4) / 3) + 4

/** A base64 payload is letters, digits, `+/`, with at most two trailing `=` pads. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

/** The marker pair delimiting this service's row inside the user patch layer. */
function rowMarkers(id: string): readonly [string, string] {
  return [`# >>> dsh-plugin-install ${id}\n`, `# <<< dsh-plugin-install ${id}\n`]
}

/**
 * Locate the running instance's profile directory from the bootstrap include
 * entry. `mountRootInclude` pins `id: 'include'` whose `config.path` is the
 * profile's `cordis.yml` file URL; its directory is the profile directory.
 * @param ctx - context carrying an initialized Loader service.
 * @returns the profile directory, or `undefined` when no include entry is composed.
 */
function selfLocatedProfileDir(ctx: Context): string | undefined {
  for (const entry of ctx.loader.entries()) {
    if (entry.id !== 'include') continue
    const path = (entry.options.config as { readonly path?: unknown } | undefined)?.path
    if (typeof path === 'string') return dirname(fileURLToPath(path))
  }
  return undefined
}

/**
 * Insert (or replace) the plugin's `- insert:` row in the profile patch layer.
 * The row is delimited by id-marked comment lines, so a reinstall replaces the
 * prior row in place and every other user row, comment, and `!!js` expression
 * in the file is preserved byte-for-byte.
 * @param profileDir - the profile directory whose patch layer edits.
 * @param id - the plugin id, already validated path-safe.
 * @param moduleFileUrl - the file URL the inserted entry loads.
 */
function upsertPluginPatchRow(profileDir: string, id: string, moduleFileUrl: string): void {
  const block = `${rowMarkers(id)[0]}- insert:\n    - id: ${id}\n      name: ${JSON.stringify(moduleFileUrl)}\n${rowMarkers(id)[1]}`
  upsertMarkedBlock(join(profileDir, PROFILE_PATCH_FILENAME), block, id)
}

/**
 * Replace (or append) one id-delimited block inside a patch-layer file,
 * preserving every byte outside the block.
 * @param patchPath - the profile's cordis.patch.yml path.
 * @param block - the full replacement text, delimited by the id markers.
 * @param id - the plugin id whose markers delimit the block.
 */
function upsertMarkedBlock(patchPath: string, block: string, id: string): void {
  let content: string
  try {
    content = readFileSync(patchPath, 'utf8')
  } catch {
    // Missing patch layer: the fresh content below becomes the whole file.
    content = ''
  }
  const [start, end] = rowMarkers(id)
  const open = content.indexOf(start)
  const close = content.indexOf(end)
  const next = open >= 0 && close >= open
    ? `${content.slice(0, open)}${block}${content.slice(close + end.length)}`
    : content === ''
      ? block
      : `${content.replace(/\n*$/, '')}\n${block}`
  writeFileSync(patchPath, next)
}

/** Reject an id that is not a single path-safe segment. */
function assertPluginId(id: string): void {
  if (id === '' || id === '.' || id === '..' || !PLUGIN_ID_PATTERN.test(id)) {
    throw new RemoteError(
      'plugin-install/invalid-spec',
      `plugin id ${JSON.stringify(id)} must be a single path-safe segment (letters, digits, . _ -)`,
      { reason: `plugin id ${JSON.stringify(id)} is not a single path-safe segment` },
    )
  }
}

/**
 * Finish a directory install under `plugins/<id>`: write the loose-plugin
 * manifest when the directory ships none, then register its patch row.
 * @param profileDir - the profile whose patch layer edits.
 * @param id - the plugin id, already validated path-safe.
 * @param destDir - the materialized plugin directory under `plugins/<id>`.
 */
function finalizeDirectoryInstall(profileDir: string, id: string, destDir: string): void {
  if (!existsSync(join(destDir, 'package.json'))) {
    writeFileSync(join(destDir, 'package.json'), JSON.stringify(LOOSE_PLUGIN_MANIFEST, undefined, 2) + '\n')
  }
  upsertPluginPatchRow(profileDir, id, pathToFileURL(join(destDir, 'index.ts')).href)
}

/** Install the file-dir form: copy the source directory and register its patch row. */
function installFileDir(profileDir: string, spec: FileDirInstallSpec): PluginInstallResult {
  assertPluginId(spec.id)
  if (!isAbsolute(spec.sourcePath)) {
    throw new RemoteError(
      'plugin-install/invalid-spec',
      `source path must be absolute; got ${JSON.stringify(spec.sourcePath)}`,
      { reason: `sourcePath ${JSON.stringify(spec.sourcePath)} is not absolute` },
    )
  }
  if (!existsSync(spec.sourcePath)) {
    throw new RemoteError(
      'plugin-install/invalid-spec',
      `source directory ${spec.sourcePath} does not exist`,
      { reason: `sourcePath ${spec.sourcePath} does not exist` },
    )
  }
  const pluginsDir = join(profileDir, PLUGINS_DIR)
  const destDir = join(pluginsDir, spec.id)
  try {
    // A reinstall replaces the prior copy wholesale, mirroring the patch-row replace.
    rmSync(destDir, { recursive: true, force: true })
    mkdirSync(pluginsDir, { recursive: true })
    cpSync(spec.sourcePath, destDir, { recursive: true })
    finalizeDirectoryInstall(profileDir, spec.id, destDir)
  } catch (error) {
    throw new RemoteError(
      'plugin-install/write-failed',
      `failed to install plugin ${spec.id} into ${profileDir}: ${String(error)}`,
      { reason: String(error) },
      { cause: error },
    )
  }
  return { form: 'file-dir', profileDir, pluginId: spec.id }
}

/** Reject an uploaded relative path that could escape `plugins/<id>` or name a non-file. */
function assertUploadPath(path: string): void {
  if (path === '' || path === '.' || path === '..'
    || path.startsWith('/')
    || path.includes('\\') || path.includes('\0')
    || /^[A-Za-z]:/.test(path)
    || path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new RemoteError(
      'plugin-install/invalid-spec',
      `uploaded file path ${JSON.stringify(path)} must be a safe relative path`,
      { reason: `uploaded file path ${JSON.stringify(path)} is not a safe relative path` },
    )
  }
}

/**
 * Decode one uploaded file and write it under the destination directory.
 * @param destDir - the plugin directory receiving the file.
 * @param file - one base64-carrying upload entry.
 * @returns the decoded byte length, for the running total.
 */
function writeUploadedFile(destDir: string, file: DirectoryUploadFile): number {
  assertUploadPath(file.path)
  if (file.content.length > MAX_UPLOAD_FILE_BASE64 || !BASE64_PATTERN.test(file.content)) {
    throw new RemoteError(
      'plugin-install/invalid-spec',
      `uploaded file ${JSON.stringify(file.path)} is not valid base64`,
      { reason: `uploaded file ${JSON.stringify(file.path)} is not valid base64` },
    )
  }
  const bytes = Buffer.from(file.content, 'base64')
  if (bytes.length > MAX_UPLOAD_FILE_BYTES) {
    throw new RemoteError(
      'plugin-install/upload-too-large',
      `uploaded file ${JSON.stringify(file.path)} exceeds the ${MAX_UPLOAD_FILE_BYTES}-byte file ceiling`,
      { maxBytes: MAX_UPLOAD_FILE_BYTES, actualBytes: bytes.length },
    )
  }
  const target = join(destDir, file.path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  return bytes.length
}

/**
 * Accept either a bare package spec (forwarded to `pnpm add` verbatim) or a
 * full install command — `dsh plugin --profile <name> add <spec>` or
 * `pnpm add <spec>` — and return the spec `pnpm add` should receive. The
 * command form lets an operator paste the CLI invocation into the WebUI field
 * instead of hand-extracting the trailing package spec.
 * @param input - the npm-bundle field value.
 * @returns the package spec to forward, never the surrounding command.
 */
function parseNpmSpec(input: string): string {
  const trimmed = input.trim()
  const tokens = trimmed.split(/\s+/)
  const addIndex = tokens.indexOf('add')
  if (addIndex < 0) return trimmed
  // The token right after `add`; strip quotes a shell user may have added.
  const spec = tokens[addIndex + 1]
  return spec === undefined ? trimmed : spec.replace(/^["']|["']$/g, '')
}

/**
 * Tail of pnpm's own captured output, trimmed to fit a Remote error payload.
 * Without it an operator facing a failing `pnpm add` would see only the exit
 * code, never the reason pnpm refused (unapproved build script, bad spec, ...).
 * @param output - the captured stdout and stderr chunks of the pnpm run.
 * @returns the trailing diagnostic text, or an empty string when pnpm printed none.
 */
function pnpmDiagnostics(output: readonly (string | Buffer | null)[]): string {
  const text = output
    .filter((chunk): chunk is string => typeof chunk === 'string')
    .join('')
    .trim()
  return text === '' ? '' : text.slice(-2000)
}

/** The line pnpm's ERR_PNPM_IGNORED_BUILDS marker appears on. */
const IGNORED_BUILDS_MARKER = 'ERR_PNPM_IGNORED_BUILDS'

/** pnpm's refusal marker when a git-hosted dependency's prepare script needs approval. */
const GIT_PREPARE_MARKER = 'ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED'

/**
 * The packages a pnpm diagnostic names as having an ignored build script,
 * stripped to bare names (`node-pty@1.1.0` → `node-pty`; scoped names keep
 * their scope). pnpm prints them after `Ignored build scripts:`.
 * @param output - a pnpm diagnostic tail.
 * @returns the bare package names, empty when no build was flagged.
 */
function ignoredBuildNames(output: string): readonly string[] {
  const names = new Set<string>()
  for (const line of output.split('\n')) {
    if (!line.includes('Ignored build scripts:')) continue
    for (const entry of line.slice(line.indexOf(':') + 1).split(',')) {
      const name = entry.trim().replace(/@[^@]*$/, '')
      if (name !== '') names.add(name)
    }
  }
  return [...names]
}

/**
 * The allowBuilds keys pnpm's diagnostic suggests for a refused git-hosted
 * dependency. pnpm prints the exact key to copy — `allowBuilds: <key>: true`
 * on the `For example:` line — where the key is the full pinned specifier
 * (`dsh-git-remotes@https://codeload.github.com/.../tar.gz/<sha>`), never a
 * bare package name, because a git dependency's prepare script is bound to its
 * exact resolved source.
 * @param output - a pnpm diagnostic tail.
 * @returns the suggested allowBuilds keys, empty when none is named.
 */
function gitPrepareKeys(output: string): readonly string[] {
  const keys = new Set<string>()
  for (const line of output.split('\n')) {
    const match = /\b(?:allowBuilds|"allowBuilds"):\s*(\S+):\s*true\b/.exec(line)
    if (match === null) continue
    const key = match[1]
    if (key !== undefined) keys.add(key)
  }
  return [...keys]
}

/**
 * The names whose workspace entry still carries pnpm's unapproved-build
 * placeholder (`allowBuilds: { <name>: set this to true or false }`). pnpm
 * writes that placeholder when it refuses a build script on a profile with no
 * `allowBuilds` map, then keeps treating the entry as unapproved on every
 * later run — including one whose `pnpm add` short-circuits to success because
 * the dependency tree is already resolved. Such an install leaves the native
 * binding unbuilt while reporting success, so the profile restart fails later.
 * @param workspaceYaml - the profile's pnpm-workspace.yaml path.
 * @returns the bare package names still carrying the placeholder.
 */
function placeholderIgnoredBuildNames(workspaceYaml: string): readonly string[] {
  let content: string
  try {
    content = readFileSync(workspaceYaml, 'utf8')
  } catch {
    // No workspace layer: pnpm never refused a build here.
    return []
  }
  const names = new Set<string>()
  for (const line of content.split('\n')) {
    const match = /^\s*['"]?([A-Za-z0-9@./_-]+)['"]?:\s*['"]?set this to true or false['"]?\s*$/.exec(line)
    if (match !== null) {
      const name = match[1]
      if (name !== undefined) names.add(name)
    }
  }
  return [...names]
}

/**
 * Ensure `allowBuilds.<name>: true` appears in the profile's workspace layer,
 * replacing pnpm's own invalid placeholder (`set this to true or false`) or an
 * earlier explicit deny. pnpm ≥10 blocks every dependency build script until
 * allowlisted; a fresh profile ships no `allowBuilds`, so the first `pnpm add`
 * of a native-dep package makes pnpm write a placeholder file that stays an
 * invalid value on every later run — an operator install cannot succeed
 * without this approval. The file is otherwise preserved byte-for-byte.
 * @param workspaceYaml - the profile's pnpm-workspace.yaml path.
 * @param names - bare package names to allow.
 */
function approveBuildScripts(workspaceYaml: string, names: readonly string[]): void {
  let content: string
  try {
    content = readFileSync(workspaceYaml, 'utf8')
  } catch {
    // Missing workspace layer: a minimal file with the approvals is the whole file.
    content = ''
  }
  if (content === '') {
    content = 'allowBuilds:\n'
  } else {
    const hasAllow = content.split('\n').some(line => line === 'allowBuilds:')
    if (!hasAllow) content = `${content.replace(/\n*$/, '')}\nallowBuilds:\n`
  }
  const lines = content.split('\n')
  const allowIndex = lines.findIndex(line => line === 'allowBuilds:')
  if (allowIndex < 0) return
  // The key children run until the next column-zero key (the generated file
  // is machine-shaped; anything else is preserved untouched).
  let childEnd = lines.length
  for (let i = allowIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line !== undefined && line !== '' && !/^\s/.test(line)) {
      childEnd = i
      break
    }
  }
  for (const name of names) {
    const key = /^[A-Za-z0-9._-]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`^(\\s*)['"]?${escaped}['"]?\\s*:`)
    const existing = lines.slice(allowIndex + 1, childEnd).findIndex(line => pattern.test(line))
    if (existing >= 0) {
      lines[allowIndex + 1 + existing] = `  ${key}: true`
    } else {
      lines.splice(allowIndex + 1, 0, `  ${key}: true`)
      childEnd += 1
    }
  }
  writeFileSync(workspaceYaml, lines.join('\n'))
}

/**
 * Run one `pnpm` command in the profile directory, returning its captured
 * output and exit status. Output is captured, never inherited, so failures can
 * carry pnpm's own reason (and the self-heal can read which builds were
 * refused).
 * @param profileDir - the profile whose workspace resolves the command.
 * @param args - the pnpm subcommand arguments (e.g. `['add', pkg]`).
 * @returns the exit status and diagnostic tail, or the spawn error when pnpm could not start.
 */
function runPnpm(profileDir: string, args: readonly string[]): {
  exitCode: number
  output: string
  error?: NodeJS.ErrnoException
} {
  const result = spawnSync('pnpm', [...args], {
    cwd: profileDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const output = pnpmDiagnostics([result.stdout, result.stderr])
  if (result.error !== undefined) return { exitCode: 1, output, error: result.error }
  return { exitCode: result.status ?? 1, output }
}

/**
 * Convert a failed pnpm run into the Remote error its operator can act on.
 * @param run - the run result.
 * @param profileDir - the profile directory the command ran in.
 * @param command - the pnpm command that failed, for the message.
 */
function throwPnpmFailure(run: {
  exitCode: number
  output: string
  error?: NodeJS.ErrnoException
}, profileDir: string, command: string): never {
  if (run.error !== undefined) {
    if (run.error.code === 'ENOENT') {
      throw new RemoteError(
        'plugin-install/pnpm-missing',
        'pnpm was not found on PATH — install pnpm to manage profile plugins',
        { profileDir },
        { cause: run.error },
      )
    }
    throw new RemoteError(
      'plugin-install/pnpm-failed',
      `pnpm failed to run in profile directory ${profileDir}: ${String(run.error)}${run.output === '' ? '' : `\n${run.output}`}`,
      { profileDir, exitCode: 1, output: run.output },
      { cause: run.error },
    )
  }
  throw new RemoteError(
    'plugin-install/pnpm-failed',
    `pnpm ${command} exited ${run.exitCode} in profile directory ${profileDir}${run.output === '' ? '' : `\n${run.output}`}`,
    { profileDir, exitCode: run.exitCode, output: run.output },
  )
}

/**
 * Rebuild the native bindings pnpm had previously refused, after their
 * workspace entries are approved. A short-circuited `pnpm add` can leave a
 * refused build unbuilt while reporting success; the rebuild is what actually
 * materializes the binding so the profile restart can load the plugin.
 * @param profileDir - the profile whose workspace resolves the packages.
 * @param names - bare package names to rebuild.
 */
function rebuildApprovedBuilds(profileDir: string, names: readonly string[]): void {
  const run = runPnpm(profileDir, ['rebuild', ...names])
  if (run.exitCode !== 0) throwPnpmFailure(run, profileDir, `rebuild ${names.join(' ')}`)
}

/** Install the npm-bundle form: `pnpm add` in the profile, then reconcile its layer stack. */
function installNpmBundle(profileDir: string, spec: NpmBundleInstallSpec): PluginInstallResult {
  const pkg = parseNpmSpec(spec.spec)
  if (pkg === '') {
    throw new RemoteError(
      'plugin-install/invalid-spec',
      'the npm spec must be non-empty',
      { reason: 'empty npm spec' },
    )
  }
  if (!existsSync(join(profileDir, 'package.json'))) {
    initProfile(profileDir, DEFAULT_PROFILE_BUNDLES)
  }
  const before = readProfileManifest(NAME, profileDir)
  // `pnpm add` writes the dependency and materializes the package; the profile
  // workspace already links the healed node_modules, so resolution is local.
  let run = runPnpm(profileDir, ['add', pkg])
  if (run.exitCode !== 0 && (run.output.includes(IGNORED_BUILDS_MARKER) || run.output.includes(GIT_PREPARE_MARKER))) {
    // pnpm ≥10 refuses a dependency's build script until allowlisted, and on a
    // profile without an `allowBuilds` map it writes an invalid placeholder
    // that keeps failing every later run. Approve exactly the flagged packages
    // and retry once, so a native-dep or git-hosted plugin installs without a
    // manual edit. Native-dep refusals name bare packages; git-hosted prepare
    // refusals name their full pinned specifier.
    const names = ignoredBuildNames(run.output)
    const gitKeys = gitPrepareKeys(run.output)
    const approvals = [...names, ...gitKeys]
    if (approvals.length > 0) {
      console.warn(`[${NAME}] approving build scripts pnpm refused: ${approvals.join(', ')}`)
      approveBuildScripts(join(profileDir, 'pnpm-workspace.yaml'), approvals)
      run = runPnpm(profileDir, ['add', pkg])
    }
  }
  if (run.exitCode !== 0) throwPnpmFailure(run, profileDir, 'add')
  // A `pnpm add` whose dependency tree is already resolved exits 0 even when an
  // earlier run left refused native builds behind. The workspace still carries
  // pnpm's placeholder then, so approve those entries and rebuild them now:
  // otherwise the profile restart loads a plugin whose native binding was
  // never built.
  const refused = placeholderIgnoredBuildNames(join(profileDir, 'pnpm-workspace.yaml'))
  if (refused.length > 0) {
    console.warn(`[${NAME}] rebuilding native bindings pnpm had refused: ${refused.join(', ')}`)
    approveBuildScripts(join(profileDir, 'pnpm-workspace.yaml'), refused)
    rebuildApprovedBuilds(profileDir, refused)
  }
  let added: readonly string[] = []
  try {
    added = reconcileProfileBundles({
      binName: NAME,
      // The profile is the resolution root for everything this service
      // installs: its healed node_modules holds both in-box and added bundles,
      // so the profile's own manifest is the installation anchor.
      installAnchor: join(profileDir, 'package.json'),
      profileDir,
      before,
      warn: (message) => { console.warn(`[${NAME}] ${message}`) },
    }).added
  } catch (error) {
    throw new RemoteError(
      'plugin-install/write-failed',
      `failed to reconcile the profile layer stack after pnpm add: ${String(error)}`,
      { reason: String(error) },
      { cause: error },
    )
  }
  return { form: 'npm-bundle', profileDir, bundlesAdded: added }
}

/** A registered entry config must be a plain JSON object, never an array or scalar. */
interface RegisterConfig {
  readonly value: Record<string, unknown>
}

/**
 * Parse and validate the optional JSON config an operator pasted into the
 * register form. A blank value means "no config"; anything parseable must be a
 * plain object (the Loader's plugin config is always a mapping), so an array
 * or scalar is refused here rather than written as a patch row that would
 * fail the Loader later.
 * @param configJson - the raw JSON text from the form, or undefined.
 * @returns the parsed object, or undefined when the field was blank.
 */
function parseRegisterConfig(configJson: string | undefined): RegisterConfig | undefined {
  if (configJson === undefined || configJson.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(configJson)
  } catch (error) {
    throw new RemoteError(
      'plugin-install/invalid-spec',
      `plugin config is not valid JSON: ${String(error instanceof Error ? error.message : error)}`,
      { reason: `config is not valid JSON: ${String(error instanceof Error ? error.message : error)}` },
      { cause: error },
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RemoteError(
      'plugin-install/invalid-spec',
      'plugin config must be a JSON object (key/value mapping), not an array or scalar',
      { reason: 'config must be a JSON object' },
    )
  }
  return { value: parsed as Record<string, unknown> }
}

/**
 * Verify a package specifier resolves from the profile's installed
 * dependencies, mirroring the Loader's own resolution. A specifier naming a
 * package (or a subpath within one) that is not installed must fail here with
 * an actionable message instead of surfacing as a startup error after the
 * operator restarts the instance.
 * @param profileDir - the profile whose dependency graph is the resolution root.
 * @param packageName - the registered specifier.
 */
function assertPackageResolvable(profileDir: string, packageName: string): void {
  const requireFromProfile = createRequire(join(profileDir, 'package.json'))
  try {
    requireFromProfile.resolve(packageName)
  } catch (error) {
    throw new RemoteError(
      'plugin-install/unresolved-package',
      `cannot resolve ${JSON.stringify(packageName)} from the profile's installed dependencies — install it first (npm-bundle form) or check the package name`,
      { profileDir, packageName },
      { cause: error },
    )
  }
}

/**
 * Install the npm-register form: register a startup row for an already
 * installed Cordis npm plugin (the plain-dependency case the npm-bundle form's
 * reconcile does not promote). The row is idempotent under the plugin id.
 * @param profileDir - the profile whose patch layer edits.
 * @param spec - the register request.
 * @returns the form that ran and the id it registered.
 */
function installNpmRegister(profileDir: string, spec: NpmRegisterInstallSpec): PluginInstallResult {
  assertPluginId(spec.id)
  const packageName = spec.packageName.trim()
  if (packageName === '') {
    throw new RemoteError(
      'plugin-install/invalid-spec',
      'the package name must be non-empty',
      { reason: 'empty package name' },
    )
  }
  assertPackageResolvable(profileDir, packageName)
  const config = parseRegisterConfig(spec.configJson)
  const entry = config === undefined ? { id: spec.id, name: packageName } : { id: spec.id, name: packageName, config: config.value }
  // The patch layer is a top-level list whose element is `- insert:` carrying
  // the registered entry; js-yaml renders the nested config mapping correctly.
  const [start, end] = rowMarkers(spec.id)
  const block = `${start}${dump([{ insert: [entry] }])}${end}`
  try {
    upsertMarkedBlock(join(profileDir, PROFILE_PATCH_FILENAME), block, spec.id)
  } catch (error) {
    throw new RemoteError(
      'plugin-install/write-failed',
      `failed to register plugin ${spec.id} into ${profileDir}: ${String(error)}`,
      { reason: String(error) },
      { cause: error },
    )
  }
  return { form: 'npm-register', profileDir, pluginId: spec.id }
}

/**
 * When a supervisor runs this instance (env `DSH_SUPERVISED=1`), request a
 * process restart after a successful install so the new plugin activates. The
 * marker protocol matches the shell supervisor's `spawn-user` loop: write
 * `RESTART_MARKER` in the profile directory, then self-SIGTERM after a grace
 * period so the Remote response reaches the browser before the process exits.
 * Without the env var the process stays up — a bare `dsh` run has no
 * supervisor to relaunch it, and killing it would strand the terminal.
 * @param profileDir - the profile that received the install.
 */
function requestRestartIfSupervised(profileDir: string): void {
  if (process.env[DSH_SUPERVISED_ENV] !== '1') return
  writeFileSync(join(profileDir, RESTART_MARKER), `${new Date().toISOString()}\n`)
  console.warn(`[${NAME}] install complete; requesting supervisor restart in ${String(RESTART_GRACE_MS)}ms`)
  setTimeout(() => {
    // SIGTERM is the supervisor's ordinary stop request and exits 0; the
    // marker left above is what tells spawn-user to relaunch rather than stop.
    process.kill(process.pid, 'SIGTERM')
  }, RESTART_GRACE_MS).unref()
}

/** Operator-gated Remote service installing external plugins into the profile. */
export class PluginInstallGateway extends TypertRemoteService {
  static inject = ['loader']

  static Config: Schema<Config> = z.object({
    enabled: z.boolean().default(false),
    profileDir: z.string(),
  })

  /** The explicit profile-directory override, when a deployment supplies one. */
  private readonly profileDir: string | undefined

  constructor(ctx: Context, config: Config) {
    if (!config.enabled) {
      throw new Error(
        'pluginInstall: the operator switch is off (config enabled: false); '
        + 'mount this service only with enabled: true',
      )
    }
    super(ctx, 'pluginInstall')
    this.profileDir = config.profileDir
  }

  /** Resolve the target profile directory: the override, else the self-located running profile. */
  private resolveProfileDir(): string {
    if (this.profileDir !== undefined) return this.profileDir
    const self = selfLocatedProfileDir(this.ctx)
    if (self === undefined) {
      throw new RemoteError(
        'plugin-install/unknown-profile',
        'cannot locate the running profile directory: no bootstrap include entry is composed and no profileDir is configured',
        { reason: 'no loader include entry and no profileDir config' },
      )
    }
    return self
  }

  /**
   * Install one plugin into the running profile. `file-dir` copies a source
   * directory under `plugins/` and registers its patch row; `upload-directory`
   * materializes a browser-picked directory carried over the Remote channel;
   * `npm-bundle` forwards `pnpm add` in the profile directory and promotes
   * bundles into the `dsh.profile.bundles` layer list; `npm-register` writes
   * a startup row for an already-installed Cordis npm plugin.
   * @param spec - the install request, discriminated by form.
   * @returns the form that ran and what it wrote.
   */
  @Remote('installPlugin')
  installPlugin(spec: PluginInstallSpec): PluginInstallResult {
    const profileDir = this.resolveProfileDir()
    const result = spec.form === 'file-dir'
      ? installFileDir(profileDir, spec)
      : spec.form === 'upload-directory'
        ? this.uploadDirectory(spec)
        : spec.form === 'npm-register'
          ? installNpmRegister(profileDir, spec)
          : installNpmBundle(profileDir, spec)
    // A supervised instance exits after a successful install so the supervisor
    // relaunches it with the new plugin active.
    requestRestartIfSupervised(result.profileDir)
    return result
  }

  /**
   * Install a browser-picked plugin directory: decode each base64-carrying
   * upload under `plugins/<id>`, then register its patch row. The file count
   * and byte ceilings bound how much operator-triggered base64 a running
   * instance decodes and writes.
   * @param spec - the directory upload request.
   * @returns the form that ran and what it wrote.
   */
  @Remote('uploadDirectory')
  uploadDirectory(spec: UploadDirectorySpec): PluginInstallResult {
    assertPluginId(spec.id)
    if (spec.files.length === 0) {
      throw new RemoteError(
        'plugin-install/invalid-spec',
        'uploaded directory must contain at least one file',
        { reason: 'empty directory upload' },
      )
    }
    if (spec.files.length > MAX_UPLOAD_FILES) {
      throw new RemoteError(
        'plugin-install/upload-too-many-files',
        `uploaded directory contains ${spec.files.length} files, exceeding the ${MAX_UPLOAD_FILES} file ceiling`,
        { maxFiles: MAX_UPLOAD_FILES, fileCount: spec.files.length },
      )
    }
    const profileDir = this.resolveProfileDir()
    const pluginsDir = join(profileDir, PLUGINS_DIR)
    const destDir = join(pluginsDir, spec.id)
    let totalBytes = 0
    try {
      // A reinstall replaces the prior copy wholesale, mirroring the patch-row replace.
      rmSync(destDir, { recursive: true, force: true })
      mkdirSync(pluginsDir, { recursive: true })
      for (const file of spec.files) {
        totalBytes += writeUploadedFile(destDir, file)
        if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
          throw new RemoteError(
            'plugin-install/upload-too-large',
            `uploaded directory exceeds the ${MAX_UPLOAD_TOTAL_BYTES}-byte total ceiling`,
            { maxBytes: MAX_UPLOAD_TOTAL_BYTES, actualBytes: totalBytes },
          )
        }
      }
      finalizeDirectoryInstall(profileDir, spec.id, destDir)
    } catch (error) {
      // Spec rejections surface as-is; filesystem failures are write failures.
      if (error instanceof RemoteError) throw error
      throw new RemoteError(
        'plugin-install/write-failed',
        `failed to install uploaded plugin ${spec.id} into ${profileDir}: ${String(error)}`,
        { reason: String(error) },
        { cause: error },
      )
    }
    return { form: 'upload-directory', profileDir, pluginId: spec.id }
  }
}

export default PluginInstallGateway
