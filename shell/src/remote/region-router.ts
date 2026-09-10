/**
 * Region-router filesystem: ONE ctx.fs serving both the local server disk and
 * every paired agent's mounted root (design.md §7.9).
 *
 * dsh's workspace model requires a workspace path to be a real, stat-able
 * server directory. Each paired agent root is therefore mirrored by a real
 * "shadow" directory under the configured shadow root. A workspace inside
 * that shadow tree is an ordinary dsh workspace; when fs tooling touches it,
 * this provider translates the shadow path back to the owning agent's real
 * path and forwards the operation through the hub.
 *
 * This provider EXTENDS the sandboxed local filesystem: local paths inherit
 * the full local + sandbox semantics (resolve/stat/read/atomic write/literal
 * edit/version guards), while shadow-tree paths are dispatched to the agent.
 * Loading it as a loader row therefore needs no delegate assembly — the class
 * registers as ctx.fs the same way fs-sandbox did, and the loader waits for
 * the inherited sandboxPolicy inject exactly as it did for fs-sandbox.
 *
 * @module dsh-team-shell/region-router
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem, type Config as SandboxedFsConfig } from '@deepseek-ai/dsh-fs-sandbox'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsErrorCode,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsVersion as FsVersionBrand,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { isAbsolute, resolve as pathResolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listMounts, fsOp, HubFsError } from './client.ts'
import { translateShadowPath, type ShadowTranslation } from './shadow.ts'
import type { MountRecord } from './hub.ts'

/** The local filesystem config plus the region-router's own knobs. */
export interface Config extends SandboxedFsConfig {
  /** Hub control API base the router forwards mounted operations to. */
  hubUrl: string
  /** Root holding every mount's shadow directory. */
  shadowRoot: string
  /** Hub user id of this instance; only that user's mounts are remote-served. */
  user: string
  /**
   * The account's private workspace directory — the only local path this
   * instance may READ besides its mounted shadow roots. Omitted for the bare
   * (non-team) region-router form, which keeps the inherited read-anywhere
   * local semantics.
   */
  workspaceRoot?: string
}

type ResolvedConfig = Required<Pick<Config, 'hubUrl' | 'shadowRoot' | 'user'>> & { workspaceRoot?: string }

type ProbeWire = { version: string; type: 'file' | 'directory' | 'symlink' | 'other'; size: number } | null
type ListEntryWire = { name: string; type: 'file' | 'directory' | 'other'; targetKey: string; version?: string; size?: number }

/** Whether a canonical path is the root or a descendant of it (lexical, no symlink walk). */
function isLexicallyUnder(path: string, root: string): boolean {
  if (path === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return path.startsWith(prefix)
}

/** Re-raise an agent/hub failure as the seam's typed FsError. */
function toFsError(error: unknown, fallback: string): FsError {
  if (error instanceof HubFsError) {
    const code = error.code
    if (code !== undefined && code.startsWith('FS_')) {
      return new FsError(error.message, code as FsErrorCode, { cause: error })
    }
    return new FsError(error.message, 'FS_IO_ERROR', { cause: error })
  }
  if (error instanceof FsError) return error
  return new FsError(fallback, 'FS_IO_ERROR', { cause: error })
}

/**
 * One ctx.fs: local server paths through the inherited sandboxed local
 * backend, mounted shadow-tree paths through the owning remote agent.
 */
export class RegionRouterFileSystem extends SandboxedFileSystem {
  /** Region knobs validated from the row config. */
  private readonly region: ResolvedConfig
  private mountsCache: readonly MountRecord[] | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    if (typeof config.hubUrl !== 'string' || config.hubUrl === '') throw new Error('region-fs: hubUrl is required')
    if (typeof config.shadowRoot !== 'string' || config.shadowRoot === '') throw new Error('region-fs: shadowRoot is required')
    if (typeof config.user !== 'string' || config.user === '') throw new Error('region-fs: user is required')
    this.region = {
      hubUrl: config.hubUrl.replace(/\/+$/, ''),
      shadowRoot: config.shadowRoot.replace(/\/+$/, ''),
      user: config.user,
      ...config.workspaceRoot === undefined ? {} : { workspaceRoot: canonicalPath(config.workspaceRoot.replace(/\/+$/, '')) },
    }
    void this.refreshMounts()
  }

  private async refreshMounts(): Promise<void> {
    try {
      this.mountsCache = await listMounts(this.region.hubUrl)
    } catch {
      this.mountsCache = []
    }
  }

  /**
   * Ensure the mount cache is warm for a shadow path before dispatch. The
   * cache is pulled fire-and-forget at construction, so an access that arrives
   * before the pull settles (or before a freshly paired agent registered)
   * would otherwise fall through to the empty local shadow stub.
   */
  private async refreshFor(path: string): Promise<void> {
    if (!this.isShadow(path) || this.remoteOf(path) !== undefined) return
    await this.refreshMounts()
  }

  /** Whether an absolute server path is inside the shadow root. */
  private isShadow(path: string): boolean {
    const root = this.region.shadowRoot
    return path === root || path.startsWith(root + sep)
  }

  /** Translate a shadow path to our own agent's real path, if it is a mount. */
  private remoteOf(path: string): ShadowTranslation | undefined {
    const t = translateShadowPath(path, this.mountsCache ?? [])
    if (t === undefined || t.user !== this.region.user) return undefined
    return t
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    const abs = isAbsolute(path) ? path : pathResolve(opts?.cwd ?? this.config.cwd, path)
    if (this.isShadow(abs)) {
      await this.refreshFor(abs)
      const t = this.remoteOf(abs)
      if (t !== undefined) {
        const value = await this.fsRemote(t, { op: 'resolve', path: t.remotePath })
        if (typeof value !== 'object' || value === null) throw new Error('remote resolve returned no target')
        const { targetKey } = value as { targetKey: string }
        // Shadow path is the caller-visible identity; targetKey is opaque.
        return { targetKey: FsTargetKey(`${abs}#${t.user}#${targetKey}`), displayPath: abs }
      }
    }
    return super.resolve(path, opts)
  }

  override processPath(target: FsTarget): string {
    // A shadow target's process path is its display face; local targets use
    // the inherited realpath key. Both are absolute server paths.
    return target.displayPath
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  /** Whether the target's display path is a mounted shadow path. */
  private shadowTarget(target: FsTarget): ShadowTranslation | undefined {
    return this.remoteOf(target.displayPath)
  }

  /**
   * Enforce the account's read boundary on a LOCAL target: a read outside the
   * private workspace is denied with `FS_PERMISSION_DENIED`. Mounted shadow
   * targets are remote-served and skip this fence; a region-router with no
   * `workspaceRoot` keeps the inherited read-anywhere semantics.
   * @param target - the resolved target (its `targetKey` is the canonical path).
   */
  private async assertLocalReadable(target: FsTarget): Promise<void> {
    if (this.shadowTarget(target) !== undefined) return
    const root = this.region.workspaceRoot
    if (root === undefined) return
    if (!isLexicallyUnder(String(target.targetKey), root)) {
      throw new FsError(
        `cannot read "${target.displayPath}": access denied outside the account workspace`,
        'FS_PERMISSION_DENIED',
      )
    }
  }

  /** Enforce the read boundary on a LOCAL absolute path (the `lstat` shape). */
  private async assertLocalPathReadable(abs: string): Promise<void> {
    if (this.isShadow(abs)) return
    const root = this.region.workspaceRoot
    if (root === undefined) return
    if (!isLexicallyUnder(canonicalPath(abs), root)) {
      throw new FsError(`cannot read "${abs}": access denied outside the account workspace`, 'FS_PERMISSION_DENIED')
    }
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const t = this.shadowTarget(target)
    if (t !== undefined) {
      const info = await this.fsRemote(t, { op: 'stat', path: t.remotePath }) as ProbeWire
      if (!info) return undefined
      const type: 'file' | 'directory' | 'other' = info.type === 'symlink' ? 'other' : info.type
      return { version: FsVersion(info.version), type, size: info.size }
    }
    await this.assertLocalReadable(target)
    return super.stat(target, signal)
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const abs = isAbsolute(path) ? path : pathResolve(opts?.cwd ?? this.config.cwd, path)
    if (this.isShadow(abs)) {
      const t = this.remoteOf(abs)
      if (t !== undefined) {
        const info = await this.fsRemote(t, { op: 'lstat', path: t.remotePath }) as ProbeWire
        if (!info) return undefined
        return { version: FsVersion(info.version), type: info.type, size: info.size }
      }
    }
    await this.assertLocalPathReadable(abs)
    return super.lstat(path, opts, signal)
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const t = this.shadowTarget(target)
    if (t !== undefined) {
      const text = await this.fsRemote(t, { op: 'readText', path: t.remotePath })
      if (typeof text !== 'string') throw new Error('remote readText returned no content')
      return text
    }
    await this.assertLocalReadable(target)
    return super.readText(target, signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const text = await this.readText(target, signal)
    return (async function* () {
      const chunkSize = 64 * 1024
      for (let i = 0; i < text.length; i += chunkSize) {
        if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
        yield text.slice(i, i + chunkSize)
      }
    })()
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const t = this.shadowTarget(target)
    if (t !== undefined) {
      const value = await this.fsRemote(t, { op: 'readBytes', path: t.remotePath, maxBytes })
      if (typeof value !== 'object' || value === null || typeof (value as { base64?: unknown }).base64 !== 'string') {
        throw new Error('remote readBytes returned no bytes')
      }
      return Buffer.from((value as { base64: string }).base64, 'base64')
    }
    await this.assertLocalReadable(target)
    return super.readBytes(target, signal, maxBytes)
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const t = this.shadowTarget(target)
    if (t !== undefined) {
      const value = await this.fsRemote(t, { op: 'readByteRange', path: t.remotePath, offset: range.offset, length: range.length })
      if (typeof value !== 'object' || value === null || typeof (value as { base64?: unknown }).base64 !== 'string') {
        throw new Error('remote readByteRange returned no bytes')
      }
      return Buffer.from((value as { base64: string }).base64, 'base64')
    }
    await this.assertLocalReadable(target)
    return super.readByteRange(target, range, signal)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const t = this.shadowTarget(target)
    if (t !== undefined) {
      const value = await this.fsRemote(t, { op: 'list', path: t.remotePath })
      if (!Array.isArray(value)) throw new Error('remote list returned no entries')
      const entries = value as unknown as ListEntryWire[]
      return entries.map(entry => ({
        name: entry.name,
        type: entry.type === 'directory' ? 'directory' : entry.type === 'file' ? 'file' : 'other',
        target: {
          targetKey: FsTargetKey(entry.targetKey),
          displayPath: entry.targetKey,
        },
        ...entry.version !== undefined ? { version: FsVersion(entry.version) } : {},
        ...entry.size !== undefined ? { size: entry.size } : {},
      }))
    }
    await this.assertLocalReadable(target)
    return super.listDir(target, signal)
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: import('@deepseek-ai/dsh-sandbox').SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const t = this.shadowTarget(target)
    if (t !== undefined) {
      const value = await this.fsRemote(t, {
        op: 'write',
        path: t.remotePath,
        content,
        expected: expected as { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: string } | undefined,
      })
      if (typeof value !== 'object' || value === null) throw new Error('remote write returned no outcome')
      const outcome = value as { operation: 'create' | 'update'; version: string; before: string | null; after: string }
      return {
        operation: outcome.operation,
        version: FsVersion(outcome.version),
        before: outcome.before,
        after: outcome.after,
      }
    }
    return super.writeText(target, content, expected, signal, sandboxPolicy)
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersionBrand },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    const t = this.shadowTarget(target)
    if (t !== undefined) {
      const value = await this.fsRemote(t, {
        op: 'edit',
        path: t.remotePath,
        oldString: edit.oldString,
        newString: edit.newString,
        replaceAll: edit.replaceAll,
        expected: expected === undefined ? undefined : { kind: 'replaceIfVersion', version: expected.version },
      })
      if (typeof value !== 'object' || value === null) throw new Error('remote edit returned no outcome')
      const outcome = value as { version: string; before: string; after: string }
      return {
        version: FsVersion(outcome.version),
        before: outcome.before,
        after: outcome.after,
      }
    }
    return super.editText(target, edit, expected, signal)
  }

  /** Issue one fs primitive to the translation's owning agent. */
  private async fsRemote(t: ShadowTranslation, spec: {
    op: 'resolve' | 'stat' | 'lstat' | 'list' | 'readText' | 'readBytes' | 'readByteRange' | 'write' | 'edit'
    path?: string
    maxBytes?: number
    offset?: number
    length?: number
    content?: string
    expected?: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: string }
    oldString?: string
    newString?: string
    replaceAll?: boolean
  }): Promise<unknown> {
    try {
      return await fsOp(this.region.hubUrl, t.user, spec, t.mount.agentId)
    } catch (error) {
      throw toFsError(error, 'remote filesystem operation failed')
    }
  }
}

export default RegionRouterFileSystem
