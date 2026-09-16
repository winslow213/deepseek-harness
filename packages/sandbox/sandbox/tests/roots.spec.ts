/**
 * Tests for the writable-root derivation: the mode's meaning as a canonical
 * allow-list. Pinned here so the fs fence and the Seatbelt profile — both
 * deriving from `writableRoots` — cannot drift.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath, readShield, writableRoots } from '@deepseek-ai/dsh-sandbox'

/** Every temp root created by this file, removed after each test. */
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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

describe('readShield', () => {
  /** A shared users root with one account home inside it, real on disk. */
  function usersRoot(): { root: string; home: string } {
    const root = mkdtempSync(join(tmpdir(), 'dsh-users-'))
    roots.push(root)
    const home = join(root, 'alice')
    mkdirSync(home)
    return { root, home }
  }

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
