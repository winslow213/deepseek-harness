/**
 * Remote-agent filesystem semantics — a zero-dependency port of the dsh fs
 * local backend's IO core.
 *
 * The agent runs on the user's own host as a standalone process, so it cannot
 * import `@deepseek-ai/dsh-fs-local`; these functions reproduce the exact
 * behaviors the seam contract relies on: version derivation from high-
 * resolution stat identity, regular-file/binary/UTF-8 rejection, LF
 * normalization and restoration, literal-edit matching, and atomic write
 * publication. Errors carry the seam's `FS_*` codes so the center-side
 * provider can re-raise structured {@link @deepseek-ai/dsh-fs} errors.
 *
 * Every function here operates on an already root-allowlisted real path: the
 * caller (agent.ts) resolves and verifies the path before invoking it.
 *
 * @module dsh-team-shell/remote-agent-fs
 */

import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { Dirent } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Structured filesystem failure carrying the seam's `FS_*` code. */
export interface RemoteFsError {
  readonly name: 'RemoteFsError'
  readonly code: string
  readonly message: string
}

/** Raise a typed filesystem failure. */
export function fsError(code: string, message: string): never {
  throw { name: 'RemoteFsError', code, message } satisfies RemoteFsError
}

/** Narrow an unknown thrown value to a typed fs failure. */
export function isRemoteFsError(error: unknown): error is RemoteFsError {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'RemoteFsError'
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function isENOTDIR(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOTDIR'
}

function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EPERM'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** NUL-scan width for binary rejection. */
const BINARY_SAMPLE_BYTES = 8192

/** Version token from high-resolution identity and freshness metadata. */
function versionOf(info: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

type PathKind = 'file' | 'directory' | 'symlink' | 'other'

function pathType(info: { isFile(): boolean; isDirectory(): boolean }): 'file' | 'directory' | 'other' {
  if (info.isFile()) return 'file'
  if (info.isDirectory()) return 'directory'
  return 'other'
}

/** Stat a path with bigint identity; null when the path or a parent is absent. */
async function probeStats<T extends { isFile(): boolean; isDirectory(): boolean }>(
  absolutePath: string,
  readStats: (path: string) => Promise<T>,
): Promise<T | null> {
  try {
    return await readStats(absolutePath)
  } catch (error: unknown) {
    if (!isENOENT(error) && !isENOTDIR(error)) throw error
    return null
  }
}

export interface ProbeResult {
  version: string
  type: PathKind
  size: number
}

/** Probe a path following symlinks; null when absent. */
export async function probe(absolutePath: string): Promise<ProbeResult | null> {
  const info = await probeStats(absolutePath, (path) => stat(path, { bigint: true }))
  if (info === null) return null
  return { version: versionOf(info as Parameters<typeof versionOf>[0]), type: pathType(info), size: Number(info.size) }
}

/** Probe a path without following the final symlink; `symlink` is reported. */
export async function probeNoFollow(absolutePath: string): Promise<ProbeResult | null> {
  const info = await probeStats(absolutePath, (path) => lstat(path, { bigint: true }))
  if (info === null) return null
  const isLink = (info as { isSymbolicLink(): boolean }).isSymbolicLink()
  return {
    version: versionOf(info as Parameters<typeof versionOf>[0]),
    type: isLink ? 'symlink' : pathType(info),
    size: Number(info.size),
  }
}

/**
 * Resolve a path to a stable realpath identity. For a missing target, realpath
 * the nearest existing ancestor and re-append the missing suffix so the key is
 * stable across later creation of that file.
 */
export async function resolveIdentity(path: string): Promise<{ displayPath: string; targetKey: string }> {
  const displayPath = path
  try {
    return { displayPath, targetKey: await realpath(displayPath) }
  } catch (error: unknown) {
    if (isENOTDIR(error)) fsError('FS_NOT_FOUND', `cannot resolve "${displayPath}": a parent path segment is not a directory`)
    if (!isENOENT(error)) throw error
  }
  const missing = [basename(displayPath)]
  let ancestor = dirname(displayPath)
  for (;;) {
    try {
      const realAncestor = await realpath(ancestor)
      return { displayPath, targetKey: join(realAncestor, ...missing) }
    } catch (error: unknown) {
      if (!isENOENT(error)) throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) return { displayPath, targetKey: displayPath }
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

/** Read a whole regular UTF-8 text file with binary rejection. */
export async function readText(absolutePath: string): Promise<string> {
  const info = await probe(absolutePath)
  if (info === null) fsError('FS_NOT_FOUND', `cannot read "${absolutePath}": not found`)
  if (info?.type !== 'file') fsError('FS_NOT_REGULAR_FILE', `cannot read "${absolutePath}": not a regular file`)
  const raw = await readFile(absolutePath)
  if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    fsError('FS_NOT_TEXT', `cannot read "${absolutePath}": binary file`)
  }
  return decodeUtf8(raw, 'read', absolutePath)
}

function decodeUtf8(buffer: Uint8Array, verb: 'read' | 'edit', displayPath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error
    fsError('FS_NOT_TEXT', `cannot ${verb} "${displayPath}": invalid UTF-8 text`)
  }
}

type LineEndings = 'LF' | 'CRLF'

function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  const lfCount = sample.split('\n').length - 1 - crlfCount
  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

function restoreLineEndings(content: string, lineEndings: LineEndings): string {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

/** Read and decode a file for editing: reject binary, normalize LF, keep style. */
async function readForEdit(absolutePath: string): Promise<{ content: string; lineEndings: LineEndings }> {
  const buffer = await readFile(absolutePath)
  if (buffer.includes(0)) fsError('FS_NOT_TEXT', `cannot edit "${absolutePath}": binary file`)
  const raw = decodeUtf8(buffer, 'edit', absolutePath)
  return { content: normalizeLineEndings(raw), lineEndings: detectLineEndings(raw) }
}

/** Apply a literal replacement to LF-normalized content (seam edit semantics). */
export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): { content: string; replacements: number } {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) fsError('FS_EDIT_NOT_FOUND', 'old_string must be a non-empty string')
  const newNorm = normalizeLineEndings(newString)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) fsError('FS_EDIT_NOT_FOUND', `old_string was not found in "${displayPath}"`)
  if (!replaceAll && replacements > 1) {
    fsError('FS_AMBIGUOUS_EDIT', `old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`)
  }
  return { content: content.split(oldNorm).join(newNorm), replacements }
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  for (;;) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * Atomically write content to a file through a synced staging file in the same
 * directory, preserving the existing mode when present. Missing parent
 * directories are created. `createIfAbsent` publishes with a hard-link so a
 * concurrent creator's file is preserved.
 */
export async function writeFileAtomic(
  absolutePath: string,
  content: string,
  createIfAbsent?: { displayPath: string },
): Promise<void> {
  const directory = dirname(absolutePath)
  await mkdir(directory, { recursive: true })

  const existingMode = await existingFileMode(absolutePath)
  const stagingDir = join(directory, `.${basename(absolutePath)}.${process.pid}.${randomUUID()}.tmpdir`)
  const tempPath = join(stagingDir, `${basename(absolutePath)}.tmp`)
  let stagingCreated = false
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    await mkdir(stagingDir, { mode: 0o700 })
    stagingCreated = true
    await chmod(stagingDir, 0o700)
    handle = await open(tempPath, 'wx', 0o600)
    await handle.chmod(0o600)
    await handle.writeFile(content, { encoding: 'utf8' })
    await handle.sync()
    if (existingMode !== undefined) await handle.chmod(existingMode)
    await handle.close()
    handle = undefined

    if (createIfAbsent !== undefined) {
      try {
        const { link } = await import('node:fs/promises')
        await link(tempPath, absolutePath)
      } catch (error: unknown) {
        await throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath)
      }
    } else {
      await rename(tempPath, absolutePath)
    }
    await rm(stagingDir, { recursive: true, force: true })
  } catch (error: unknown) {
    if (handle !== undefined) {
      try { await handle.close() } catch { /* double fault */ }
    }
    if (!stagingCreated) throw error
    try {
      await rm(stagingDir, { recursive: true, force: true })
    } catch { /* cleanup double fault */ }
    throw error
  }
}

async function existingFileMode(absolutePath: string): Promise<number | undefined> {
  try {
    const info = await stat(absolutePath)
    if (info.isFile()) return info.mode & 0o777
    fsError('FS_NOT_REGULAR_FILE', `cannot write "${absolutePath}": not a regular file`)
  } catch (error: unknown) {
    if (!isENOENT(error) && !isENOTDIR(error)) throw error
    return undefined
  }
}

async function throwGuardedCreateFailure(error: unknown, absolutePath: string, displayPath: string): Promise<never> {
  let existing: Awaited<ReturnType<typeof lstat>> | undefined
  try {
    existing = await lstat(absolutePath)
  } catch (metadataError: unknown) {
    if (!isENOENT(metadataError) && !isENOTDIR(metadataError)) throw metadataError
  }
  if (existing !== undefined) {
    if (!existing.isFile()) fsError('FS_NOT_REGULAR_FILE', `cannot write "${displayPath}": not a regular file`, )
    fsError('FS_NOT_OBSERVED', `cannot overwrite existing "${displayPath}" without reading it first`)
  }
  if (isEEXIST(error)) {
    fsError('FS_NOT_OBSERVED', `cannot overwrite existing "${displayPath}" without reading it first`)
  }
  if (isPermissionError(error)) {
    fsError('FS_PERMISSION_DENIED', `cannot write "${displayPath}": permission denied`)
  }
  fsError('FS_IO_ERROR', `cannot write "${displayPath}": ${errorMessage(error)}`)
}

/** The guarded write intent, serialized over the wire. */
export type WireWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: string }

export interface WriteRemoteResult {
  operation: 'create' | 'update'
  version: string
  before: string | null
  after: string
}

/**
 * Full-file write with the seam's guard semantics. Probes first for stale
 * checks, writes atomically, and reports before/after text plus the new version.
 */
export async function writeRemote(
  absolutePath: string,
  content: string,
  expected: WireWriteIntent | undefined,
): Promise<WriteRemoteResult> {
  const beforeProbe = await probe(absolutePath)
  if (expected?.kind === 'createIfAbsent' && beforeProbe !== null) {
    fsError('FS_NOT_OBSERVED', `cannot write "${absolutePath}": target already exists`)
  }
  if (expected?.kind === 'replaceIfVersion') {
    if (beforeProbe === null) fsError('FS_STALE_VERSION', `cannot write "${absolutePath}": target missing`)
    if (beforeProbe.version !== expected.version) {
      fsError('FS_STALE_VERSION', `cannot write "${absolutePath}": target changed since read`)
    }
  }
  const beforeText = beforeProbe === null || beforeProbe.type !== 'file'
    ? null
    : await bestEffortDiffBasis(absolutePath)
  await writeFileAtomic(absolutePath, content, expected?.kind === 'createIfAbsent' ? { displayPath: absolutePath } : undefined)
  const afterProbe = await probe(absolutePath)
  return {
    operation: beforeProbe === null ? 'create' : 'update',
    version: afterProbe?.version ?? `missing:${absolutePath}`,
    before: beforeText,
    after: normalizeLineEndings(content),
  }
}

export interface EditRemoteResult {
  version: string
  before: string
  after: string
}

/**
 * Literal edit with the seam's guard semantics: stale check before literal
 * matching, then read→match→restore→atomic write in one serialized section.
 */
export async function editRemote(
  absolutePath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  expected: { version: string } | undefined,
): Promise<EditRemoteResult> {
  const beforeProbe = await probe(absolutePath)
  if (beforeProbe === null) fsError('FS_STALE_VERSION', `cannot edit "${absolutePath}": target missing`)
  if (expected !== undefined && beforeProbe?.version !== expected.version) {
    fsError('FS_STALE_VERSION', `cannot edit "${absolutePath}": target changed since read`)
  }
  if (beforeProbe?.type !== 'file') fsError('FS_NOT_REGULAR_FILE', `cannot edit "${absolutePath}": not a regular file`)
  const { content, lineEndings } = await readForEdit(absolutePath)
  const { content: edited } = applyLiteralEdit(content, oldString, newString, replaceAll, absolutePath)
  const restored = restoreLineEndings(edited, lineEndings)
  await writeFileAtomic(absolutePath, restored)
  const afterProbe = await probe(absolutePath)
  return {
    version: afterProbe?.version ?? `missing:${absolutePath}`,
    before: content,
    after: edited,
  }
}

/** Best-effort overwrite diff basis: null for non-text or oversized files. */
async function bestEffortDiffBasis(absolutePath: string): Promise<string | null> {
  try {
    const info = await stat(absolutePath)
    if (!info.isFile()) return null
    if (info.size >= 4 * 1024 * 1024) return null
    const buffer = await readFile(absolutePath)
    if (buffer.includes(0)) return null
    try {
      return normalizeLineEndings(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
    } catch {
      return null
    }
  } catch {
    return null
  }
}

/** List direct children with cheap metadata, in stable name order. */
export async function listRemote(absolutePath: string): Promise<Array<{
  name: string
  type: 'file' | 'directory' | 'other'
  targetKey: string
  version: string | undefined
  size: number | undefined
}>> {
  const dirInfo = await probe(absolutePath)
  if (dirInfo === null) fsError('FS_NOT_FOUND', `cannot list "${absolutePath}": not found`)
  if (dirInfo?.type !== 'directory') fsError('FS_NOT_DIRECTORY', `cannot list "${absolutePath}": not a directory`)
  let entries: Dirent<string>[]
  try {
    entries = await readdir(absolutePath, { withFileTypes: true, encoding: 'utf8' })
  } catch (error: unknown) {
    if (isPermissionError(error)) fsError('FS_PERMISSION_DENIED', `cannot list "${absolutePath}": permission denied`)
    throw error
  }
  const result: Array<{ name: string; type: 'file' | 'directory' | 'other'; targetKey: string; version: string | undefined; size: number | undefined }> = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const childPath = join(absolutePath, entry.name)
    const childInfo = await probe(childPath)
    // Resolve the child's stable realpath identity (missing children keep the
    // ancestor-realpath key) so list results can feed guarded reads/writes.
    let targetKey: string
    try {
      targetKey = (await resolveIdentity(childPath)).targetKey
    } catch {
      targetKey = childPath
    }
    result.push({
      name: entry.name,
      type: childInfo?.type === 'directory' ? 'directory' : childInfo?.type === 'file' ? 'file' : 'other',
      targetKey,
      version: childInfo?.version,
      size: childInfo?.type === 'file' ? childInfo.size : undefined,
    })
  }
  return result
}

/** Read a file's raw bytes with an inclusive size cap. */
export async function readBytes(absolutePath: string, maxBytes: number): Promise<{ bytes: Uint8Array }> {
  const info = await stat(absolutePath)
  if (!info.isFile()) fsError('FS_NOT_REGULAR_FILE', `cannot read "${absolutePath}": not a regular file`)
  if (info.size > maxBytes) {
    fsError('FS_TOO_LARGE', `cannot read "${absolutePath}": ${String(info.size)} bytes exceeds the ${String(maxBytes)}-byte limit`)
  }
  const chunks: Buffer[] = []
  let total = 0
  const stream = createReadStream(absolutePath, { end: maxBytes })
  for await (const chunk of stream) {
    total += chunk.length
    if (total > maxBytes) fsError('FS_TOO_LARGE', `cannot read "${absolutePath}": content exceeds the ${String(maxBytes)}-byte limit`)
    chunks.push(chunk)
  }
  return { bytes: Buffer.concat(chunks, total) }
}
