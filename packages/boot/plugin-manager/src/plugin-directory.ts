/**
 * Installing a plugin the profile owns as a directory rather than an npm
 * dependency: the operator's copy of a plugin source tree, or a directory a
 * browser picked and sent as base64. Both materialize under `plugins/<id>` and
 * register the patch row {@link installPluginDirectory} names, so the two forms
 * differ only in where the bytes come from. `plugins/` is profile-private: no
 * package manager resolves from it, and the row names the copied entry file
 * directly by file URL.
 * @module @deepseek-ai/dsh-plugin-manager/plugin-directory
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PROFILE_PATCH_FILENAME } from '@deepseek-ai/dsh-app-boot'
import { ManagementFailure } from './failure.ts'
import { assertPluginId, removePluginRow, writePluginRow } from './plugin-row.ts'

/** The profile-private directory holding directory-form plugin copies. */
export const PLUGINS_DIR = 'plugins'

/** The loose-plugin manifest written when a copied directory ships none. */
const LOOSE_PLUGIN_MANIFEST = { type: 'module' } as const

/**
 * Directory-upload ceilings. Security invariants, not tunables: they bound how
 * much operator-triggered base64 a running instance decodes and writes.
 */
const MAX_UPLOAD_FILES = 512
const MAX_UPLOAD_FILE_BYTES = 1024 * 1024
const MAX_UPLOAD_TOTAL_BYTES = 10 * 1024 * 1024
/** The base64 length of a `MAX_UPLOAD_FILE_BYTES` payload, plus `=` padding. */
const MAX_UPLOAD_FILE_BASE64 = Math.ceil((MAX_UPLOAD_FILE_BYTES * 4) / 3) + 4

/** A base64 payload is letters, digits, `+/`, with at most two trailing `=` pads. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

/** One file of a browser-picked directory, carried over the Remote channel as base64. */
export interface PluginDirectoryFile {
  /** POSIX-style path relative to the picked directory; safe segments joined by `/`. */
  readonly path: string
  /** File content encoded as base64. */
  readonly content: string
}

/** One directory-form installation: the plugin id, and the bytes to materialize. */
export type PluginDirectorySource =
  | { readonly form: 'file-dir'; readonly id: string; readonly sourcePath: string }
  | { readonly form: 'upload-directory'; readonly id: string; readonly files: readonly PluginDirectoryFile[] }

/** The profile's `cordis.patch.yml`, the layer the row protocol writes. */
function patchPathOf(profileDir: string): string {
  return join(profileDir, PROFILE_PATCH_FILENAME)
}

/**
 * Reject an uploaded relative path that could escape `plugins/<id>` or name
 * something other than a file inside it. The browser supplies these, so they
 * are a wire boundary: a drive letter, a backslash, a NUL, or any `.`/`..`
 * segment is refused rather than normalized.
 * @param path The uploaded relative path.
 * @throws {ManagementFailure} `invalid-spec` for a path that is not a safe relative path.
 */
function assertUploadPath(path: string): void {
  if (path === '' || path === '.' || path === '..'
    || path.startsWith('/')
    || path.includes('\\') || path.includes('\0')
    || /^[A-Za-z]:/.test(path)
    || path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new ManagementFailure('invalid-spec', undefined, `uploaded file path ${JSON.stringify(path)} is not a safe relative path`)
  }
}

/**
 * Decode one uploaded file and write it under the destination directory.
 * @param destDir The plugin directory receiving the file.
 * @param file One decoded upload entry.
 */
function writeUploadedFile(destDir: string, file: DecodedFile): void {
  const target = join(destDir, file.path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, file.bytes)
}

/** One upload entry after its path and payload were accepted. */
interface DecodedFile {
  readonly path: string
  readonly bytes: Buffer
}

/**
 * Check one uploaded file and decode it, applying every ceiling before any
 * byte reaches the profile.
 * @param file One base64-carrying upload entry.
 * @returns the accepted path and its decoded bytes.
 * @throws {ManagementFailure} `invalid-spec` for a path that is not a safe relative path or a payload
 * that is not base64 within the per-file encode ceiling; `upload-too-large` for decoded bytes over
 * the per-file ceiling.
 */
function decodeUploadedFile(file: PluginDirectoryFile): DecodedFile {
  assertUploadPath(file.path)
  if (file.content.length > MAX_UPLOAD_FILE_BASE64 || !BASE64_PATTERN.test(file.content)) {
    throw new ManagementFailure('invalid-spec', undefined, `uploaded file ${JSON.stringify(file.path)} is not valid base64`)
  }
  const bytes = Buffer.from(file.content, 'base64')
  if (bytes.length > MAX_UPLOAD_FILE_BYTES) {
    throw new ManagementFailure(
      'upload-too-large', undefined,
      `uploaded file ${JSON.stringify(file.path)} is ${bytes.length} bytes, over the ${MAX_UPLOAD_FILE_BYTES}-byte per-file ceiling`,
    )
  }
  return { path: file.path, bytes }
}

/**
 * Decode a browser-picked directory's files, enforcing the count, per-file, and
 * total byte ceilings.
 * @param files The uploaded files, each with its relative path.
 * @returns the accepted files, in upload order.
 * @throws {ManagementFailure} `invalid-spec` for an empty directory or a refused file; and the
 * per-file and count and total ceilings of {@link decodeUploadedFile} and `MAX_UPLOAD_FILES`.
 */
function decodeUpload(files: readonly PluginDirectoryFile[]): DecodedFile[] {
  if (files.length === 0) {
    throw new ManagementFailure('invalid-spec', undefined, 'an uploaded plugin directory must contain at least one file')
  }
  if (files.length > MAX_UPLOAD_FILES) {
    throw new ManagementFailure(
      'upload-too-many-files', undefined,
      `the uploaded directory carries ${files.length} files, over the ${MAX_UPLOAD_FILES}-file ceiling`,
    )
  }
  const decoded: DecodedFile[] = []
  let total = 0
  for (const file of files) {
    const accepted = decodeUploadedFile(file)
    total += accepted.bytes.length
    if (total > MAX_UPLOAD_TOTAL_BYTES) {
      throw new ManagementFailure(
        'upload-too-large', undefined,
        `the uploaded directory is over the ${MAX_UPLOAD_TOTAL_BYTES}-byte total ceiling`,
      )
    }
    decoded.push(accepted)
  }
  return decoded
}

/**
 * Check the operator's plugin source directory.
 * @param sourcePath The source directory.
 * @throws {ManagementFailure} `invalid-spec` when the path is not absolute or does not exist.
 */
function assertCopySource(sourcePath: string): void {
  if (!isAbsolute(sourcePath)) {
    throw new ManagementFailure('invalid-spec', undefined, `a plugin source path must be absolute: ${JSON.stringify(sourcePath)}`)
  }
  if (!existsSync(sourcePath)) {
    throw new ManagementFailure('invalid-spec', undefined, `plugin source directory ${sourcePath} does not exist`)
  }
}

/**
 * Finishing step shared by both directory forms: write the loose-plugin
 * manifest when the materialized directory ships none, then register the patch
 * row naming its entry file.
 * @param profileDir The profile whose patch layer edits.
 * @param id The plugin id, already validated path-safe.
 * @param destDir The materialized plugin directory under `plugins/<id>`.
 */
function writeDirectoryRow(profileDir: string, id: string, destDir: string): void {
  if (!existsSync(join(destDir, 'package.json'))) {
    writeFileSync(join(destDir, 'package.json'), `${JSON.stringify(LOOSE_PLUGIN_MANIFEST, undefined, 2)}\n`)
  }
  writePluginRow(patchPathOf(profileDir), id, { id, name: pathToFileURL(join(destDir, 'index.ts')).href })
}

/**
 * Install a plugin directory into the profile: copy the operator's source tree
 * or materialize an uploaded one under `plugins/<id>`, then register its patch
 * row. A reinstall replaces the prior copy wholesale, mirroring the row
 * replacement.
 *
 * The whole request is checked before the first write, so a refused install
 * leaves the copy a previous one placed under `plugins/<id>` intact. Only a
 * filesystem failure after that point can leave the directory partly written.
 * @param profileDir The profile directory receiving the plugin.
 * @param source The plugin id, and the bytes to materialize from a local path or an upload.
 * @throws {ManagementFailure} `invalid-spec` for a path or upload the form refuses; the upload
 * ceilings; `operation-error` when a copy or write fails.
 */
export function installPluginDirectory(profileDir: string, source: PluginDirectorySource): void {
  const id = source.id
  assertPluginId(id)
  const decoded = source.form === 'file-dir' ? (assertCopySource(source.sourcePath), undefined) : decodeUpload(source.files)
  const pluginsDir = join(profileDir, PLUGINS_DIR)
  const destDir = join(pluginsDir, id)
  try {
    rmSync(destDir, { recursive: true, force: true })
    mkdirSync(pluginsDir, { recursive: true })
    if (source.form === 'file-dir') cpSync(source.sourcePath, destDir, { recursive: true })
    else for (const file of decoded ?? []) writeUploadedFile(destDir, file)
    writeDirectoryRow(profileDir, id, destDir)
  } catch (error) {
    if (error instanceof ManagementFailure) throw error
    throw new ManagementFailure('operation-error', undefined, `failed to install plugin ${id} into ${profileDir}: ${String(error)}`)
  }
}

/**
 * Remove a directory-form plugin: its patch row, and the `plugins/<id>` copy
 * alongside it. An id that has no row is a no-op, so a caller that also covers
 * other install forms can delegate unconditionally.
 * @param profileDir The profile directory to remove from.
 * @param id The plugin id to remove.
 * @returns whether a patch row for `id` was found and removed.
 */
export async function removePluginDirectory(profileDir: string, id: string): Promise<boolean> {
  assertPluginId(id)
  if (!removePluginRow(patchPathOf(profileDir), id)) return false
  await rm(join(profileDir, PLUGINS_DIR, id), { recursive: true, force: true })
  return true
}
