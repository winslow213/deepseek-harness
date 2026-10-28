/**
 * Tests for the writable-root derivation: the mode's meaning as a canonical
 * allow-list. Pinned here so the fs fence and the Seatbelt profile — both
 * deriving from `writableRoots` — cannot drift, and so the workspace-plus-
 * additional set stays one shared derivation across backend dialects.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath, readShield, workspaceWritableRoots, writableRoots } from '@deepseek-ai/dsh-sandbox'

/** Every temp root created by this file, removed after each test. */
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A shared users root with one account home inside it, real on disk. */
function usersRoot(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-users-'))
  roots.push(root)
  const home = join(root, 'alice')
  mkdirSync(home)
  return { root, home }
}

describe('canonicalPath', () => {
  it('resolves symlinks (an existing path realpaths)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-roots-'))
    roots.push(dir)
    expect(canonicalPath(dir)).toBe(realpathSync.native(dir))
  })

  it('returns the spelling as-is when the path cannot be resolved (conservative — matches nothing until it exists)', () => {
    expect(canonicalPath('/does/not/exist/anywhere-xyz')).toBe('/does/not/exist/anywhere-xyz')
  })
})

describe('workspaceWritableRoots', () => {
  it('workspace-write grants only the workspace when no extra root is configured', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    roots.push(ws)
    expect(workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws })).toEqual([realpathSync.native(ws)])
  })

  it('workspace-write deduplicates physical extra directories and rejects symlink aliases', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const extra = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-extra-')))
    const alias = join(ws, 'alias')
    symlinkSync(extra, alias, 'dir')
    roots.push(ws, extra)
    const grants = workspaceWritableRoots({
      mode: 'workspace-write',
      workspaceRoot: ws,
      additionalWritableRoots: [extra, extra],
    })
    expect(grants).toEqual([realpathSync.native(ws), realpathSync.native(extra)])
    expect(() => workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws, additionalWritableRoots: [alias] }))
      .toThrow('use the physical directory path')
  })

  it('rejects missing and non-directory extra roots before granting access', () => {
    const ws = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-roots-')))
    roots.push(ws)
    const file = join(ws, 'file.txt')
    writeFileSync(file, 'file')
    expect(() => workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws, additionalWritableRoots: [file] }))
      .toThrow('expected an existing directory')
    expect(() => workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws, additionalWritableRoots: [join(ws, 'missing')] }))
      .toThrow('cannot read the directory')
  })

  it('read-only grants nothing even when extra roots are carried on the policy', () => {
    expect(workspaceWritableRoots({ mode: 'read-only', workspaceRoot: '/ws', additionalWritableRoots: ['/extra'] })).toEqual([])
    expect(writableRoots({ mode: 'read-only', workspaceRoot: '/ws', additionalWritableRoots: ['/extra'] })).toEqual([])
  })
})

describe('writableRoots', () => {
  it('read-only grants nothing', () => {
    expect(writableRoots({ mode: 'read-only', workspaceRoot: process.cwd() })).toEqual([])
  })

  it('workspace-write grants the workspace root plus the platform temp areas, canonical and deduplicated', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    roots.push(ws)
    const writable = writableRoots({ mode: 'workspace-write', workspaceRoot: ws })
    expect(writable).toContain(realpathSync.native(ws))
    expect(writable).toContain(canonicalPath('/tmp'))
    expect(writable).toContain(realpathSync.native(tmpdir()))
    // Deduplicated after canonicalization (/tmp and os.tmpdir() may coincide).
    expect(new Set(writable).size).toBe(writable.length)
  })

  it('workspace-write includes an explicit extra directory beside the temp areas', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const extra = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-extra-')))
    roots.push(ws, extra)
    expect(writableRoots({
      mode: 'workspace-write',
      workspaceRoot: ws,
      additionalWritableRoots: [extra],
    })).toContain(realpathSync.native(extra))
  })
})

describe('workspaceWritableRoots additional grants', () => {
  /** A real directory to grant, under a caller-provided parent. */
  function grant(parent = tmpdir()): string {
    const dir = mkdtempSync(join(parent, 'dsh-grant-'))
    roots.push(dir)
    return realpathSync.native(dir)
  }

  it('grants nothing under read-only — the mode withholds every write', () => {
    expect(workspaceWritableRoots({ mode: 'read-only', workspaceRoot: process.cwd(), additionalWritableRoots: [grant()] }))
      .toEqual([])
  })

  it('grants nothing under danger-full-access, which needs no grant', () => {
    expect(workspaceWritableRoots({ mode: 'danger-full-access', workspaceRoot: process.cwd(), additionalWritableRoots: [grant()] }))
      .toEqual([])
  })

  it('returns the canonical grant under workspace-write', () => {
    const dir = grant()
    expect(workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: process.cwd(), additionalWritableRoots: [dir] }))
      .toContain(realpathSync.native(dir))
  })

  it('carries only the workspace when the policy names no extra root (the pre-existing semantics)', () => {
    const ws = grant()
    expect(workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws })).toEqual([realpathSync.native(ws)])
    expect(workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws, additionalWritableRoots: [] })).toEqual([realpathSync.native(ws)])
  })

  it('deduplicates grants that canonicalize to one path', () => {
    const dir = grant()
    const listed = workspaceWritableRoots({
      mode: 'workspace-write',
      workspaceRoot: process.cwd(),
      additionalWritableRoots: [dir, `${dir}/`, dir],
    })
    expect(listed.filter(root => root === realpathSync.native(dir))).toEqual([realpathSync.native(dir)])
  })

  it('rejects / — that is danger-full-access by another name', () => {
    expect(() => workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: process.cwd(), additionalWritableRoots: ['/'] }))
      .toThrow('the filesystem root grants everything')
  })

  it('rejects a grant equal to a mode-owned mount, which would replace it', () => {
    const ws = grant()
    expect(() => workspaceWritableRoots({
      mode: 'workspace-write',
      workspaceRoot: ws,
      additionalWritableRoots: [ws],
    })).toThrow('would re-expose the mode-owned mount')
  })

  it('rejects a grant that is an ancestor of a mode-owned mount, which would re-expose what that mount hides', () => {
    const parent = grant()
    const ws = join(parent, 'workspace')
    mkdirSync(ws)
    expect(() => workspaceWritableRoots({
      mode: 'workspace-write',
      workspaceRoot: ws,
      additionalWritableRoots: [parent],
    })).toThrow('would re-expose the mode-owned mount')
  })

  it('keeps a grant that merely sits under a mode-owned mount (binding it replaces nothing)', () => {
    const under = grant(tmpdir())
    expect(workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: process.cwd(), additionalWritableRoots: [under] }))
      .toContain(realpathSync.native(under))
  })

  it('keeps a sibling whose path shares a prefix with a mode-owned mount', () => {
    const ws = grant()
    const sibling = `${ws}-elsewhere`
    mkdirSync(sibling)
    roots.push(realpathSync.native(sibling))
    expect(workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: ws, additionalWritableRoots: [sibling] }))
      .toContain(realpathSync.native(sibling))
  })
})

describe('writableRoots with extra grants', () => {
  it('adds the granted roots to the mode-owned allow-list', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    roots.push(ws)
    const shared = mkdtempSync(join(tmpdir(), 'dsh-shared-'))
    roots.push(shared)
    const writable = writableRoots({ mode: 'workspace-write', workspaceRoot: ws, additionalWritableRoots: [shared] })
    expect(writable).toContain(realpathSync.native(shared))
    expect(writable).toContain(realpathSync.native(ws))
    expect(new Set(writable).size).toBe(writable.length)
  })
})

describe('readShield with extra grants', () => {
  it('re-exposes a grant buried inside a denied root, which the shield would otherwise hide', () => {
    const { root, home } = usersRoot()
    const shared = join(root, 'shared')
    mkdirSync(shared)
    const shield = readShield({
      mode: 'workspace-write',
      workspaceRoot: process.cwd(),
      readDeniedRoots: [root],
      readAllowedRoots: [home],
      additionalWritableRoots: [shared],
    })
    expect(shield.allowed).toContain(realpathSync.native(shared))
    expect(shield.allowed).toContain(realpathSync.native(home))
  })

  it('drops a grant outside every denied root, which nothing hides', () => {
    const { root } = usersRoot()
    const outside = mkdtempSync(join(tmpdir(), 'dsh-elsewhere-'))
    roots.push(outside)
    const shield = readShield({
      mode: 'workspace-write',
      workspaceRoot: process.cwd(),
      readDeniedRoots: [root],
      additionalWritableRoots: [outside],
    })
    expect(shield.allowed).toEqual([])
  })

  it('re-exposes a grant under read-only too — a grant never narrows a read', () => {
    const { root, home } = usersRoot()
    const shared = join(root, 'shared')
    mkdirSync(shared)
    const shield = readShield({
      mode: 'read-only',
      workspaceRoot: process.cwd(),
      readDeniedRoots: [root],
      readAllowedRoots: [home],
      additionalWritableRoots: [shared],
    })
    expect(shield.allowed).toContain(realpathSync.native(shared))
  })

  it('names no boundary when the policy declares no denied root, grants included', () => {
    const shared = mkdtempSync(join(tmpdir(), 'dsh-shared-'))
    roots.push(shared)
    expect(readShield({
      mode: 'workspace-write',
      workspaceRoot: process.cwd(),
      additionalWritableRoots: [shared],
    })).toEqual({ denied: [], allowed: [] })
  })
})

describe('readShield', () => {
  it('names no boundary when the policy declares no denied root (single-tenant default)', () => {
    expect(readShield({ mode: 'workspace-write', workspaceRoot: process.cwd() }))
      .toEqual({ denied: [], allowed: [] })
  })

  it('canonicalizes and deduplicates the denied roots', () => {
    const { root } = usersRoot()
    const shield = readShield({
      mode: 'workspace-write',
      workspaceRoot: process.cwd(),
      readDeniedRoots: [root, `${root}/`],
    })
    expect(shield.denied).toEqual([realpathSync.native(root)])
  })

  it('keeps an allowed root inside a denied root — the account that must stay readable', () => {
    const { root, home } = usersRoot()
    const shield = readShield({
      mode: 'workspace-write',
      workspaceRoot: process.cwd(),
      readDeniedRoots: [root],
      readAllowedRoots: [home],
    })
    expect(shield.allowed).toEqual([realpathSync.native(home)])
  })

  it('drops an allowed root outside every denied root (it would widen a read nothing hides)', () => {
    const { root } = usersRoot()
    const outside = mkdtempSync(join(tmpdir(), 'dsh-elsewhere-'))
    roots.push(outside)
    const shield = readShield({
      mode: 'workspace-write',
      workspaceRoot: process.cwd(),
      readDeniedRoots: [root],
      readAllowedRoots: [outside],
    })
    expect(shield.allowed).toEqual([])
  })

  it('refuses to deny the whole filesystem, which no re-exposure could make usable', () => {
    const { home } = usersRoot()
    expect(readShield({
      mode: 'workspace-write',
      workspaceRoot: process.cwd(),
      readDeniedRoots: ['/'],
      readAllowedRoots: [home],
    })).toEqual({ denied: [], allowed: [] })
  })

  it('does not treat a sibling with a shared prefix as inside the denied root', () => {
    const { root } = usersRoot()
    const shield = readShield({
      mode: 'workspace-write',
      workspaceRoot: process.cwd(),
      readDeniedRoots: [root],
      readAllowedRoots: [`${root}-elsewhere`],
    })
    expect(shield.allowed).toEqual([])
  })
})
