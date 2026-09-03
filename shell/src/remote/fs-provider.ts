/**
 * Remote Service Provider for the filesystem capability seam over the team hub.
 *
 * Every `ctx.fs` operation is relayed to the user's remote-agent daemon, which
 * reproduces the local fs backend's semantics (version derivation, stale
 * guards, atomic writes, literal edits) under its `--root` allowlist. This
 * provider holds no local file access: the agent is the enforcement point.
 * It reports no sandbox mode — the remote root allowlist is the fence — which
 * the tool layer accepts by omitting escalation fields.
 *
 * @module dsh-team-shell/remote-fs-provider
 */

import { resolve as pathResolve, isAbsolute, relative, sep } from 'node:path'
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
import { fsOp, hubControlBase, HubFsError } from './client.ts'

/** Plugin config supplied by the injected profile row. */
export interface RemoteFsConfig {
  /** Hub control API base (e.g. `http://127.0.0.1:7100`). */
  hubUrl: string
  /** Hub-registered user id whose remote agent serves this provider. */
  user: string
  /** Remote base directory relative paths resolve against (must live under the agent `--root`). */
  cwd: string
  /** Exclusive UTF-8 byte limit on each overwrite-diff side. */
  diffBasisMaxBytes?: number
}

export interface ResolvedRemoteFsConfig {
  hubUrl: string
  user: string
  cwd: string
  diffBasisMaxBytes: number
}

/** Apply defaults and validate a raw plugin config. */
export function resolveRemoteFsConfig(config: RemoteFsConfig): ResolvedRemoteFsConfig {
  if (typeof config.hubUrl !== 'string' || config.hubUrl === '') throw new Error('remote-fs: hubUrl is required')
  if (typeof config.user !== 'string' || config.user === '') throw new Error('remote-fs: user is required')
  if (typeof config.cwd !== 'string' || config.cwd === '') throw new Error('remote-fs: cwd is required')
  return {
    hubUrl: hubControlBase(config.hubUrl),
    user: config.user,
    cwd: config.cwd,
    diffBasisMaxBytes: config.diffBasisMaxBytes ?? 10 * 1024 * 1024,
  }
}

/** Re-raise an agent fs failure as the seam's typed FsError. */
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

/** Resolve a path to an absolute remote path against the given base. */
function absolutize(path: string, base: string): string {
  return isAbsolute(path) ? path : pathResolve(base, path)
}

/** One fs primitive result framed from the agent's wire value. */
type ProbeWire = { version: string; type: 'file' | 'directory' | 'symlink' | 'other'; size: number } | null
type ListEntryWire = { name: string; type: 'file' | 'directory' | 'other'; targetKey: string; version?: string; size?: number }

/**
 * Remote filesystem provider: one `ctx.fs` whose targets live on the user's
 * own Linux host, reached through the hub (design.md §7.5 fs half).
 */
export class RemoteFileSystem extends FileSystem {
  readonly config: ResolvedRemoteFsConfig

  constructor(ctx: Context, config: RemoteFsConfig) {
    super(ctx)
    this.config = resolveRemoteFsConfig(config)
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    const abs = absolutize(path, opts?.cwd ?? this.config.cwd)
    const value = await this.fs({ op: 'resolve', path: abs })
    if (typeof value !== 'object' || value === null) throw new Error('remote resolve returned no target')
    const { displayPath, targetKey } = value as { displayPath: string; targetKey: string }
    return { targetKey: FsTargetKey(targetKey), displayPath }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const path = relative(this.processPath(parent), this.processPath(child))
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
    const info = await this.fs({ op: 'stat', path: this.processPath(target) }) as ProbeWire
    if (!info) return undefined
    // stat follows symlinks, so a probe never reports symlink; map defensively.
    const type: 'file' | 'directory' | 'other' = info.type === 'symlink' ? 'other' : info.type
    return { version: FsVersion(info.version), type, size: info.size }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const abs = absolutize(path, opts?.cwd ?? this.config.cwd)
    const info = await this.fs({ op: 'lstat', path: abs }) as ProbeWire
    if (!info) return undefined
    return { version: FsVersion(info.version), type: info.type, size: info.size }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
    const text = await this.fs({ op: 'readText', path: this.processPath(target) })
    if (typeof text !== 'string') throw new Error('remote readText returned no content')
    return text
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
    const text = await this.readText(target, signal)
    return (async function* () {
      // Remote transfer already holds the decoded text; yield it in chunks so
      // consumers that process incrementally never wait for one giant value.
      const chunkSize = 64 * 1024
      for (let i = 0; i < text.length; i += chunkSize) {
        if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
        yield text.slice(i, i + chunkSize)
      }
    })()
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
    const value = await this.fs({ op: 'readBytes', path: this.processPath(target), maxBytes })
    if (typeof value !== 'object' || value === null || typeof (value as { base64?: unknown }).base64 !== 'string') {
      throw new Error('remote readBytes returned no bytes')
    }
    return Buffer.from((value as { base64: string }).base64, 'base64')
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    if (signal?.aborted) throw new FsError('list aborted', 'FS_ABORTED')
    const value = await this.fs({ op: 'list', path: this.processPath(target) })
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
    const value = await this.fs({
      op: 'write',
      path: this.processPath(target),
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
    const value = await this.fs({
      op: 'edit',
      path: this.processPath(target),
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

  /** Issue one fs primitive, translating agent failures to seam errors. */
  private async fs(spec: {
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
      return await fsOp(this.config.hubUrl, this.config.user, spec)
    } catch (error) {
      throw toFsError(error, 'remote filesystem operation failed')
    }
  }
}

export default RemoteFileSystem
