/**
 * Filesystem-backed A2UI tool store: one JSON document per saved tool under
 * `<harness home>/a2ui-tools/`. Each write is an atomic replace (temp sibling
 * + rename) so a concurrent reader always sees a complete document, and the
 * directory is created owner-private on first save.
 * @module @deepseek-ai/dsh-tool-a2ui-store/store
 */

import { access, constants, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { A2uiPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import { A2UI_TOOLS_DIR, isSafeA2uiToolName, type A2uiToolRecord } from './types.ts'

export type { A2uiToolRecord } from './types.ts'
export { A2UI_TOOLS_DIR, isSafeA2uiToolName } from './types.ts'

/** On-disk shape of one saved tool (the page plus its provenance). */
interface A2uiToolDocument extends A2uiToolRecord {}

/** Resolve the store directory: the configured override wins, else `<harness home>/a2ui-tools`. */
export function resolveA2uiToolsDir(configuredDir?: string): string {
  return configuredDir !== undefined && configuredDir !== ''
    ? resolve(configuredDir)
    : join(resolveDshHome(), A2UI_TOOLS_DIR)
}

/** The document path for one tool name. */
function documentPath(dir: string, name: string): string {
  return join(dir, `${name}.json`)
}

/** Validate a tool name, throwing a caller-facing error on a bad stem. */
function assertSafeName(name: string): void {
  if (!isSafeA2uiToolName(name)) {
    throw new Error(`invalid a2ui tool name ${JSON.stringify(name)}: a name is a single safe file stem (letters, digits, dot, dash, underscore; at most 64 chars)`)
  }
}

/**
 * Read every saved tool under the store directory, name-sorted. A malformed
 * or unreadable document is skipped rather than failing the whole listing, so
 * one bad file never hides the rest.
 * @param dir - the store directory.
 * @returns the saved tools, newest filename order not guaranteed (name-sorted).
 */
export async function listA2uiTools(dir: string): Promise<A2uiToolRecord[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const records: A2uiToolRecord[] = []
  for (const entry of names) {
    if (extname(entry) !== '.json') continue
    const name = entry.slice(0, -'.json'.length)
    if (!isSafeA2uiToolName(name)) continue
    try {
      const raw = await readFile(join(dir, entry), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null) continue
      const { page, savedAt } = parsed as Partial<A2uiToolDocument>
      if (typeof page !== 'object' || page === null) continue
      records.push({
        name,
        page: page as A2uiPage,
        savedAt: typeof savedAt === 'string' ? savedAt : '',
      })
    } catch {
      // A partially written or unreadable document is skipped; the next save replaces it.
    }
  }
  return records.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Persist one tool document atomically, creating the directory owner-private.
 * @param dir - the store directory.
 * @param name - the tool name (also the file stem).
 * @param page - the canonical page definition.
 * @returns the persisted record.
 */
export async function saveA2uiTool(dir: string, name: string, page: A2uiPage): Promise<A2uiToolRecord> {
  assertSafeName(name)
  const record: A2uiToolRecord = { name, page, savedAt: new Date().toISOString() }
  await writeFileAtomic(documentPath(dir, name), JSON.stringify(record, null, 2) + '\n', {
    mode: 0o600,
    dirMode: 0o700,
  })
  return record
}

/**
 * Remove one saved tool; returns false when it did not exist.
 * @param dir - the store directory.
 * @param name - the tool name to remove.
 */
export async function removeA2uiTool(dir: string, name: string): Promise<boolean> {
  assertSafeName(name)
  const target = documentPath(dir, name)
  try {
    await access(target, constants.F_OK)
  } catch {
    return false
  }
  await rm(target, { force: true })
  return true
}

/** Ensure the store directory exists (owner-private). */
export async function ensureA2uiToolsDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
}
