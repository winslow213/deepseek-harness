/**
 * Region-router filesystem: ONE ctx.fs that serves both the local server disk
 * and every paired agent's mounted root (design.md §7.9).
 *
 * dsh's workspace model requires a workspace path to be a real, stat-able
 * server directory. Each paired agent root is therefore mirrored by a real
 * "shadow" directory under the configured shadow root (created lazily when the
 * user adopts a mount). A workspace inside that shadow tree is an ordinary
 * dsh workspace; when fs/bash tooling touches it, this router translates the
 * shadow path back to the owning agent's real path and forwards the operation
 * through the hub — the shadow directory itself stays an empty shell.
 *
 * @module dsh-team-shell/region-router-fs
 */

import { relative, isAbsolute, resolve as pathResolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  FileSystem,
  FsError,
  FsTargetKey,
  FsVersion,
  type FsDirEntry,
  type FsEditOutcome,
  type FsEditRequest,
  type FsErrorCode,
  type FsInfo,
  type FsPathInfo,
  type FsTarget,
  type FsVersion as FsVersionBrand,
  type FsWriteIntent,
  type FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { listMounts, fsOp, HubFsError } from './client.ts'
import { translateShadowPath, type ShadowTranslation } from './shadow.ts'
import type { MountRecord } from './hub.ts'

/** Plugin config supplied by the injected profile row. */
export interface RegionRouterFsConfig {
  /** Hub control API base (e.g. `http://127.0.0.1:7100`). */
  hubUrl: string
  /** Root holding every mount's shadow directory (matches hub shadowRoot). */
  shadowRoot: string
}

export interface ResolvedRegionRouterFsConfig {
  hubUrl: string
  shadowRoot: string
}

/** Resolve and validate raw plugin config. */
export function resolveRegionRouterFsConfig(config: RegionRouterFsConfig): ResolvedRegionRouterFsConfig {
  if (typeof config.hubUrl !== 'string' || config.hubUrl === '') throw new Error('region-fs: hubUrl is required')
  if (typeof config.shadowRoot !== 'string' || config.shadowRoot === '') throw new Error('region-fs: shadowRoot is required')
  const root = config.shadowRoot.replace(/\/+$/, '')
  if (!isAbsolute(root)) throw new Error('region-fs: shadowRoot must be an absolute path')
  return { hubUrl: config.hubUrl.replace(/\/+$/, ''), shadowRoot: root }
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

type ProbeWire = { version: string; type: 'file' | 'directory' | 'symlink' | 'other'; size: number } | null
type ListEntryWire = { name: string; type: 'file' | 'directory' | 'other'; targetKey: string; version?: string; size?: number }

/**
 * Region router: a single FileSystem that dispatches shadow-tree accesses to
 * the owning remote agent and everything else to a supplied local delegate.
 */
export class RegionRouterFileSystem extends FileSystem {
  readonly config: ResolvedRegionRouterFsConfig
  /** Mount snapshot refreshed per call (agents connect/disconnect). */
  private mountsCache: readonly MountRecord[] | undefined

  constructor(
    ctx: Context,
    config: RegionRouterFsConfig,
    /** Local server delegate (an isolate-realm SandboxedFileSystem). */
    readonly local: FileSystem,
  ) {
    super(ctx)
    this.config = resolveRegionRouterFsConfig(config)
  }

  /** Resolve the owning agent translation for a server path, if mounted. */
  private async translate(path: string): Promise<ShadowTranslation | undefined> {
    if (this.mountsCache === undefined) {
      try {
        this.mountsCache = await listMounts(this.config.hubUrl)
      } catch {
        this.mountsCache = []
      }
      // Refresh on a short interval by invalidating after each successful use.
      setTimeout(() => { this.mountsCache = undefined }, 30_000).unref?.()
    }
    return translateShadowPath(path, this.mountsCache ?? [])
  }

  /** Whether a server path is inside the shadow root at all. */
  isShadow(path: string): boolean {
    const root = this.config.shadowRoot
    return path === root || path.startsWith(root + sep)
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    const abs = isAbsolute(path) ? path : pathResolve(opts?.cwd ?? process.cwd(), path)
    if (this.isShadow(abs)) {
      const t = await this.translate(abs)
      if (t === undefined) {
        // Shadow tree path with no online agent: let the local delegate fail
        // with a normal not-found (the shadow dir may still be empty locally).
        return this.local.resolve(abs, opts)
      }
      // Resolve against the agent to honor its realpath identity; the shadow
      // path itself is the display face.
      const value = await this.fsRemote(t, { op: 'resolve', path: t.remotePath })
      if (typeof value !== 'object' || value === null) throw new Error('remote resolve returned no target')
      const { targetKey } = value as { targetKey: string }
      return { targetKey: FsTargetKey(targetKey), displayPath: abs }
    }
    return this.local.resolve(path, opts)
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    if (!isAbsolute(hostPath)) return undefined
    return this.isShadow(hostPath) ? hostPath : this.local.processPathFromHostPath(hostPath)
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const rel = relative(this.processPath(parent), this.processPath(child))
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  }

  /** Delegate a shadow-keyed operation to its remote agent. */
  private async translateKey(key: string): Promise<ShadowTranslation | undefined> {
    return this.translate(key)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    const key = target.displayPath
    if (!this.isShadow(key)) return this.local.stat(target, signal)
    const t = await this.translateKey(key)
    if (t === undefined) return this.local.stat(target, signal)
    const info = await this.fsRemote(t, { op: 'stat', path: t.remotePath }) as ProbeWire
    if (!info) return undefined
    const type: 'file' | 'directory' | 'other' = info.type === 'symlink' ? 'other' : info.type
    return { version: FsVersion(info.version), type, size: info.size }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const abs = isAbsolute(path) ? path : pathResolve(opts?.cwd ?? process.cwd(), path)
    if (!this.isShadow(abs)) return this.local.lstat(path, opts, signal)
    const t = await this.translate(abs)
    if (t === undefined) return this.local.lstat(path, opts, signal)
    const info = await this.fsRemote(t, { op: 'lstat', path: t.remotePath }) as ProbeWire
    if (!info) return undefined
    return { version: FsVersion(info.version), type: info.type, size: info.size }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
    const key = target.displayPath
    if (!this.isShadow(key)) return this.local.readText(target, signal)
    const t = await this.translateKey(key)
    if (t === undefined) return this.local.readText(target, signal)
    const text = await this.fsRemote(t, { op: 'readText', path: t.remotePath })
    if (typeof text !== 'string') throw new Error('remote readText returned no content')
    return text
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
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
    if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
    const key = target.displayPath
    if (!this.isShadow(key)) return this.local.readBytes(target, signal, maxBytes)
    const t = await this.translateKey(key)
    if (t === undefined) return this.local.readBytes(target, signal, maxBytes)
    const value = await this.fsRemote(t, { op: 'readBytes', path: t.remotePath, maxBytes })
    if (typeof value !== 'object' || value === null || typeof (value as { base64?: unknown }).base64 !== 'string') {
      throw new Error('remote readBytes returned no bytes')
    }
    return Buffer.from((value as { base64: string }).base64, 'base64')
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    if (signal?.aborted) throw new FsError('list aborted', 'FS_ABORTED')
    const key = target.displayPath
    if (!this.isShadow(key)) return this.local.listDir(target, signal)
    const t = await this.translateKey(key)
    if (t === undefined) return this.local.listDir(target, signal)
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

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    if (signal?.aborted) throw new FsError('write aborted', 'FS_ABORTED')
    const key = target.displayPath
    if (!this.isShadow(key)) return this.local.writeText(target, content, expected, signal)
    const t = await this.translateKey(key)
    if (t === undefined) return this.local.writeText(target, content, expected, signal)
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

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersionBrand },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    if (signal?.aborted) throw new FsError('edit aborted', 'FS_ABORTED')
    const key = target.displayPath
    if (!this.isShadow(key)) return this.local.editText(target, edit, expected, signal)
    const t = await this.translateKey(key)
    if (t === undefined) return this.local.editText(target, edit, expected, signal)
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

  /** Issue one fs primitive to the translation's owning agent. */
  private async fsRemote(t: ShadowTranslation, spec: {
    op: 'resolve' | 'stat' | 'lstat' | 'list' | 'readText' | 'readBytes' | 'write' | 'edit'
    path?: string
    maxBytes?: number
    content?: string
    expected?: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: string }
    oldString?: string
    newString?: string
    replaceAll?: boolean
  }): Promise<unknown> {
    try {
      return await fsOp(this.config.hubUrl, t.user, spec)
    } catch (error) {
      throw toFsError(error, 'remote filesystem operation failed')
    }
  }
}

export default RegionRouterFileSystem
