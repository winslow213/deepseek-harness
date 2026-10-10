/**
 * Tests for the writable-root derivation: the mode's meaning as a canonical
 * allow-list. Pinned here so the fs fence and the Seatbelt profile — both
 * deriving from `writableRoots` — cannot drift.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath, effectiveRwRoots, readShield, writableRoots } from '@deepseek-ai/dsh-sandbox'

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
})

describe('effectiveRwRoots', () => {
  /** A real directory to grant, under a caller-provided parent. */
  function grant(parent = tmpdir()): string {
    const dir = mkdtempSync(join(parent, 'dsh-grant-'))
    roots.push(dir)
    return dir
  }

  it('grants nothing under read-only — the mode withholds every write', () => {
    expect(effectiveRwRoots({ mode: 'read-only', workspaceRoot: process.cwd(), rwRoots: [grant()] }))
      .toEqual([])
  })

  it('grants nothing under danger-full-access, which needs no grant', () => {
    expect(effectiveRwRoots({ mode: 'danger-full-access', workspaceRoot: process.cwd(), rwRoots: [grant()] }))
      .toEqual([])
  })

  it('returns the canonical grant under workspace-write', () => {
    const dir = grant()
    expect(effectiveRwRoots({ mode: 'workspace-write', workspaceRoot: process.cwd(), rwRoots: [dir] }))
      .toEqual([realpathSync.native(dir)])
  })

  it('grants nothing when the policy carries no extra root (the pre-existing semantics)', () => {
    expect(effectiveRwRoots({ mode: 'workspace-write', workspaceRoot: process.cwd() })).toEqual([])
    expect(effectiveRwRoots({ mode: 'workspace-write', workspaceRoot: process.cwd(), rwRoots: [] })).toEqual([])
  })

  it('deduplicates grants that canonicalize to one path', () => {
    const dir = grant()
    expect(effectiveRwRoots({
      mode: 'workspace-write',
      workspaceRoot: process.cwd(),
      rwRoots: [dir, `${dir}/`],
    })).toEqual([realpathSync.native(dir)])
  })

  it('drops a relative entry, which has no canonical identity to compare', () => {
    expect(effectiveRwRoots({
      mode: 'workspace-write',
      workspaceRoot: process.cwd(),
      rwRoots: ['relative/share', './share'],
    })).toEqual([])
  })

  it('drops / — that is danger-full-access by another name', () => {
    expect(effectiveRwRoots({ mode: 'workspace-write', workspaceRoot: process.cwd(), rwRoots: ['/'] }))
      .toEqual([])
  })

  it('drops a grant equal to a mode-owned mount, which would replace it', () => {
    const ws = grant()
    expect(effectiveRwRoots({
      mode: 'workspace-write',
      workspaceRoot: ws,
      rwRoots: [ws, canonicalPath('/tmp'), canonicalPath(tmpdir())],
    })).toEqual([])
  })

  it('drops a grant that is an ancestor of a mode-owned mount, which would re-expose what that mount hides', () => {
    const parent = grant()
    const ws = join(parent, 'workspace')
    mkdirSync(ws)
    expect(effectiveRwRoots({
      mode: 'workspace-write',
      workspaceRoot: ws,
      rwRoots: [parent],
    })).toEqual([])
  })

  it('keeps a grant that merely sits under a mode-owned mount (binding it replaces nothing)', () => {
    const under = grant(tmpdir())
    expect(effectiveRwRoots({ mode: 'workspace-write', workspaceRoot: process.cwd(), rwRoots: [under] }))
      .toEqual([realpathSync.native(under)])
  })

  it('keeps a sibling whose path shares a prefix with a mode-owned mount', () => {
    const ws = grant()
    const sibling = `${ws}-elsewhere`
    mkdirSync(sibling)
    roots.push(sibling)
    expect(effectiveRwRoots({ mode: 'workspace-write', workspaceRoot: ws, rwRoots: [sibling] }))
      .toEqual([realpathSync.native(sibling)])
  })
})

describe('writableRoots with extra grants', () => {
  it('adds the granted roots to the mode-owned allow-list', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    roots.push(ws)
    const shared = mkdtempSync(join(tmpdir(), 'dsh-shared-'))
    roots.push(shared)
    const writable = writableRoots({ mode: 'workspace-write', workspaceRoot: ws, rwRoots: [shared] })
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
      rwRoots: [shared],
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
      rwRoots: [outside],
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
      rwRoots: [shared],
    })
    expect(shield.allowed).toContain(realpathSync.native(shared))
  })

  it('names no boundary when the policy declares no denied root, grants included', () => {
    const shared = mkdtempSync(join(tmpdir(), 'dsh-shared-'))
    roots.push(shared)
    expect(readShield({
      mode: 'workspace-write',
      workspaceRoot: process.cwd(),
      rwRoots: [shared],
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
