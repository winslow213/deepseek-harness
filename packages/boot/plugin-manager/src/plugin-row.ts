/**
 * The profile patch-row protocol for a plugin that is not an npm bundle: one
 * id-delimited `- insert:` row naming the module the Loader starts, written
 * into the profile's `cordis.patch.yml` and removable by the same id. Rows are
 * delimited by comment markers rather than re-serialized, so every other user
 * row, comment, and `!!js` expression in the file survives byte-for-byte.
 * @module @deepseek-ai/dsh-plugin-manager/plugin-row
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { ManagementFailure } from './failure.ts'

/** A plugin id must be one path-safe segment, so it can never escape `plugins/`. */
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/** The marker pair delimiting one registered row inside the profile patch layer. */
function rowMarkers(id: string): readonly [string, string] {
  return [`# >>> dsh-plugin-manager ${id}\n`, `# <<< dsh-plugin-manager ${id}\n`]
}

/**
 * Reject an id that is not a single path-safe segment. The id becomes both the
 * patch row's identity and, for the directory forms, a directory name under
 * `plugins/`, so a separator or traversal segment would escape the profile.
 * @param id The plugin id as requested.
 * @throws {ManagementFailure} `invalid-spec` for an id that is not one path-safe segment.
 */
export function assertPluginId(id: string): void {
  if (id === '' || id === '.' || id === '..' || !PLUGIN_ID_PATTERN.test(id)) {
    throw new ManagementFailure(
      'invalid-spec', undefined,
      `plugin id ${JSON.stringify(id)} must be a single path-safe segment (letters, digits, . _ -)`,
    )
  }
}

/**
 * Insert (or replace) one plugin's `- insert:` row in the profile patch layer.
 * A reinstall replaces the prior row in place, so the row is idempotent under
 * the plugin id.
 * @param patchPath The profile's `cordis.patch.yml` path.
 * @param id The plugin id, already validated path-safe.
 * @param entry The Loader entry to insert: its id, module specifier, and optional config.
 */
export function writePluginRow(patchPath: string, id: string, entry: Record<string, unknown>): void {
  const [start, end] = rowMarkers(id)
  upsertMarkedBlock(patchPath, `${start}${stringify([{ insert: [entry] }])}${end}`, id)
}

/**
 * Remove one plugin's patch row.
 * @param patchPath The profile's `cordis.patch.yml` path.
 * @param id The plugin id whose markers delimit the row.
 * @returns whether a row for `id` was found and removed.
 */
export function removePluginRow(patchPath: string, id: string): boolean {
  return removeMarkedBlock(patchPath, id)
}

/**
 * Register a startup row for an npm package that is already installed in the
 * profile. This is the plain-dependency case an npm-bundle installation does
 * not promote: the package declares no `dsh.bundle`, so nothing selects it as
 * a layer, and naming it in the patch layer is what makes the Loader start it.
 * @param patchPath The profile's `cordis.patch.yml` path.
 * @param profileDir The profile whose installed dependencies resolve the specifier.
 * @param registration The plugin id, its module specifier, and optional JSON config.
 * @throws {ManagementFailure} `invalid-spec` for an empty specifier, config that is not a
 * JSON object, or an id that is not one path-safe segment; `unresolved-package` when the
 * specifier does not resolve from the profile's installed dependencies.
 */
export function registerInstalledPlugin(
  patchPath: string, profileDir: string,
  registration: { readonly id: string; readonly packageName: string; readonly configJson?: string },
): void {
  assertPluginId(registration.id)
  const packageName = registration.packageName.trim()
  if (packageName === '') {
    throw new ManagementFailure('invalid-spec', undefined, 'the package name must not be empty')
  }
  assertPackageResolvable(profileDir, packageName)
  const config = parseRegisterConfig(registration.configJson)
  writePluginRow(patchPath, registration.id, config === undefined
    ? { id: registration.id, name: packageName }
    : { id: registration.id, name: packageName, config })
}

/** A registered entry config must be a plain JSON object, never an array or scalar. */
type RegisterConfig = Record<string, unknown>

/**
 * Parse the optional JSON config a registration carries. A blank value means
 * "no config"; anything parseable must be a plain object, because the Loader's
 * plugin config is always a mapping and an array or scalar would fail at
 * startup instead of here.
 * @param configJson The raw JSON text, or undefined.
 * @returns the parsed object, or undefined when the field was blank.
 * @throws {ManagementFailure} `invalid-spec` for text that is not JSON, or JSON that is not an object.
 */
function parseRegisterConfig(configJson: string | undefined): RegisterConfig | undefined {
  if (configJson === undefined || configJson.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(configJson)
  } catch (error) {
    throw new ManagementFailure('invalid-spec', undefined, `plugin config is not valid JSON: ${String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ManagementFailure('invalid-spec', undefined, 'plugin config must be a JSON object (key/value mapping), not an array or scalar')
  }
  return parsed as RegisterConfig
}

/**
 * Verify a specifier resolves from the profile's installed dependencies,
 * mirroring the Loader's own resolution. A specifier naming a package that is
 * not installed must fail here with an actionable refusal instead of surfacing
 * as a startup error after the operator restarts the instance.
 * @param profileDir The profile whose dependency graph is the resolution root.
 * @param packageName The specifier to resolve.
 * @throws {ManagementFailure} `unresolved-package` when the specifier does not resolve.
 */
function assertPackageResolvable(profileDir: string, packageName: string): void {
  const requireFromProfile = createRequire(join(profileDir, 'package.json'))
  try {
    requireFromProfile.resolve(packageName)
  } catch {
    throw new ManagementFailure(
      'unresolved-package', undefined,
      `${JSON.stringify(packageName)} does not resolve from the profile's installed dependencies `
      + `in ${profileDir}; install it first (installation form) or correct the package name`,
    )
  }
}

/** Comment and blank lines, which a patch layer may interleave with its entries. */
const COMMENT_OR_BLANK = /^[ \t]*(?:#.*)?$/

/**
 * The text an appended block goes after. A fresh profile's patch template is
 * its comments followed by the empty flow sequence `[]`, and a block item
 * cannot follow a flow sequence at the same level — appending to it would
 * produce a file no YAML parser accepts — so that one token is dropped and the
 * comments stay where they were. A top-level flow sequence that already holds
 * entries is refused rather than corrupted: converting it would mean
 * re-serializing the whole file, which is what this writer's markers exist to
 * avoid.
 * @param patchPath The patch layer being written, named in the refusal.
 * @param content The layer's current text.
 * @returns the text to append after.
 * @throws {ManagementFailure} `operation-error` for a top-level flow sequence carrying entries.
 */
function appendBase(patchPath: string, content: string): string {
  const lines = content.split('\n')
  const empty = lines.findIndex(line => line.trim() === '[]')
  const isOnlyThat = empty >= 0 && lines.every((line, at) => at === empty || COMMENT_OR_BLANK.test(line))
  const base = isOnlyThat ? lines.filter((_line, at) => at !== empty).join('\n') : content
  const flow = base.split('\n').find(line => line.startsWith('['))
  if (flow !== undefined) {
    throw new ManagementFailure(
      'operation-error', undefined,
      `${patchPath} holds a top-level flow sequence (${flow.trim()});`
      + ' convert the patch layer to block entries so a plugin row can be appended',
    )
  }
  return base
}

/**
 * Replace (or append) one id-delimited block inside a patch-layer file,
 * preserving every byte outside the block.
 * @param patchPath The profile's `cordis.patch.yml` path.
 * @param block The full replacement text, delimited by the id's markers.
 * @param id The plugin id whose markers delimit the block.
 */
function upsertMarkedBlock(patchPath: string, block: string, id: string): void {
  let content = ''
  try {
    content = readFileSync(patchPath, 'utf8')
  } catch (error) {
    // A missing patch layer becomes exactly this block; any other read failure
    // would misreport the file as absent and is reported instead.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const [start, end] = rowMarkers(id)
  const open = content.indexOf(start)
  const close = content.indexOf(end)
  if (open >= 0 && close >= open) {
    writeFileSync(patchPath, `${content.slice(0, open)}${block}${content.slice(close + end.length)}`)
    return
  }
  const base = appendBase(patchPath, content)
  writeFileSync(patchPath, base === '' ? block : `${base.replace(/\n*$/, '')}\n${block}`)
}

/**
 * Remove one id-delimited block from a patch-layer file, preserving every byte
 * outside it.
 * @param patchPath The profile's `cordis.patch.yml` path.
 * @param id The plugin id whose markers delimit the block.
 * @returns whether a block for `id` was found and removed.
 */
function removeMarkedBlock(patchPath: string, id: string): boolean {
  let content: string
  try {
    content = readFileSync(patchPath, 'utf8')
  } catch (error) {
    // No patch layer means no row of ours is there to remove.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return false
  }
  const [start, end] = rowMarkers(id)
  const open = content.indexOf(start)
  const close = content.indexOf(end)
  if (open < 0 || close < open) return false
  writeFileSync(patchPath, content.slice(0, open) + content.slice(close + end.length))
  return true
}
