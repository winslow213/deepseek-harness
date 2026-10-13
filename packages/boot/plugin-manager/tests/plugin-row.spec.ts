/** The profile patch-row protocol: idempotent insert rows, byte-preserving removal, npm registration. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it, onTestFinished } from 'vitest'
import { assertPluginId, registerInstalledPlugin, removePluginRow, writePluginRow } from '../src/plugin-row.ts'

/** A throwaway profile directory with a `cordis.patch.yml`, removed when its test ends. */
function profile(initialPatch = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-row-'))
  onTestFinished(() => { rmDirectory(dir) })
  writeFileSync(join(dir, 'package.json'), '{"name":"profile"}')
  if (initialPatch !== '') writeFileSync(join(dir, 'cordis.patch.yml'), initialPatch)
  return dir
}

function rmDirectory(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** Install an npm package into a fixture profile's `node_modules` so it resolves. */
function installPackage(dir: string, name: string): void {
  const path = join(dir, 'node_modules', name)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }))
  writeFileSync(join(path, 'index.js'), 'export default {}\n')
}

describe('assertPluginId', () => {
  it('accepts one path-safe segment', () => {
    for (const id of ['dsh-x', 'a.b_c-1', 'A1']) expect(() => { assertPluginId(id) }).not.toThrow()
  })

  it('refuses an empty, traversal, or separator-bearing id', () => {
    for (const id of ['', '.', '..', 'a/b', 'a\\b', 'a b', '../x', 'a\0b']) {
      expect(() => { assertPluginId(id) }, `id ${JSON.stringify(id)}`).toThrow(/must be a single path-safe segment/)
    }
  })

  it('reports the refusal as an invalid-spec failure', () => {
    expect(() => { assertPluginId('a/b') }).toThrow(expect.objectContaining({ code: 'invalid-spec' }))
  })
})

describe('writePluginRow', () => {
  it('creates the patch layer when the profile has none', () => {
    const dir = profile()
    writePluginRow(join(dir, 'cordis.patch.yml'), 'demo', { id: 'demo', name: 'demo-pkg' })
    expect(parse(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'))).toEqual([{ insert: [{ id: 'demo', name: 'demo-pkg' }] }])
  })

  it('preserves every byte outside its own block', () => {
    // One trailing newline is the round-trip-clean form: the writer normalizes
    // the count before appending, so removing the block restores the input.
    const original = '# a hand-written comment\n- id: existing\n  disabled: true\n\n# trailing comment\n'
    const dir = profile(original)
    const patch = join(dir, 'cordis.patch.yml')
    writePluginRow(patch, 'demo', { id: 'demo', name: 'demo-pkg' })
    const text = readFileSync(patch, 'utf8')
    expect(text.startsWith('# a hand-written comment\n- id: existing\n  disabled: true\n\n# trailing comment\n')).toBe(true)
    expect(text).toContain('# >>> dsh-plugin-manager demo\n')
    expect(text).toContain('# <<< dsh-plugin-manager demo\n')
    expect(removePluginRow(patch, 'demo')).toBe(true)
    expect(readFileSync(patch, 'utf8')).toBe(original)
  })

  it('appends after existing content and keeps the other rows parsed', () => {
    const dir = profile('# leading\n- id: existing\n  disabled: true\n')
    writePluginRow(join(dir, 'cordis.patch.yml'), 'demo', { id: 'demo', name: 'demo-pkg' })
    expect(parse(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')))
      .toEqual([{ id: 'existing', disabled: true }, { insert: [{ id: 'demo', name: 'demo-pkg' }] }])
  })

  it('appends to a fresh profile whose template is comments plus the empty flow sequence', () => {
    const template = '# Your patch layer for this dsh profile:\n# a top-level YAML array of loader patch entries.\n[]\n'
    const dir = profile(template)
    writePluginRow(join(dir, 'cordis.patch.yml'), 'demo', { id: 'demo', name: 'demo-pkg' })
    const text = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(text.startsWith('# Your patch layer for this dsh profile:\n# a top-level YAML array of loader patch entries.\n')).toBe(true)
    expect(text).not.toContain('[]')
    expect(parse(text)).toEqual([{ insert: [{ id: 'demo', name: 'demo-pkg' }] }])
  })

  it('refuses a patch layer holding a top-level flow sequence with entries', () => {
    const dir = profile('[{"id": "other", "disabled": true}]\n')
    expect(() => { writePluginRow(join(dir, 'cordis.patch.yml'), 'demo', { id: 'demo', name: 'demo-pkg' }) })
      .toThrow(expect.objectContaining({ code: 'operation-error' }))
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe('[{"id": "other", "disabled": true}]\n')
  })

  it('replaces its prior row in place, leaving one row per id', () => {
    const dir = profile()
    const patch = join(dir, 'cordis.patch.yml')
    writePluginRow(patch, 'demo', { id: 'demo', name: 'first-pkg' })
    writePluginRow(patch, 'demo', { id: 'demo', name: 'second-pkg' })
    const text = readFileSync(patch, 'utf8')
    expect(text.match(/dsh-plugin-manager demo/g)).toHaveLength(2)
    expect(parse(text)).toEqual([{ insert: [{ id: 'demo', name: 'second-pkg' }] }])
  })
})

describe('removePluginRow', () => {
  it('removes only its own block and reports the removal', () => {
    const before = '# leading comment\n- id: existing\n  disabled: true\n'
    const after = '# trailing comment\n'
    const dir = profile(`${before}${after}`)
    const patch = join(dir, 'cordis.patch.yml')
    writePluginRow(patch, 'demo', { id: 'demo', name: 'demo-pkg' })
    expect(removePluginRow(patch, 'demo')).toBe(true)
    expect(readFileSync(patch, 'utf8')).toBe(`${before}${after}`)
  })

  it('reports an id with no row, including when no patch layer exists', () => {
    const dir = profile('# only a comment\n')
    expect(removePluginRow(join(dir, 'cordis.patch.yml'), 'absent')).toBe(false)
    expect(removePluginRow(join(dir, 'no-such-file.yml'), 'absent')).toBe(false)
  })
})

describe('registerInstalledPlugin', () => {
  it('writes a startup row naming the installed package', () => {
    const dir = profile()
    installPackage(dir, 'dsh-probe')
    registerInstalledPlugin(join(dir, 'cordis.patch.yml'), dir, { id: 'probe', packageName: 'dsh-probe' })
    expect(parse(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')))
      .toEqual([{ insert: [{ id: 'probe', name: 'dsh-probe' }] }])
  })

  it('carries a JSON object config and omits a blank one', () => {
    const dir = profile()
    installPackage(dir, 'dsh-probe')
    const patch = join(dir, 'cordis.patch.yml')
    registerInstalledPlugin(patch, dir, { id: 'configured', packageName: 'dsh-probe', configJson: '{"size":3}' })
    registerInstalledPlugin(patch, dir, { id: 'bare', packageName: 'dsh-probe', configJson: '   ' })
    const rows = parse(readFileSync(patch, 'utf8')) as { insert: { id: string; config?: unknown }[] }[]
    expect(rows.flatMap(row => row.insert).find(row => row.id === 'configured')).toEqual({ id: 'configured', name: 'dsh-probe', config: { size: 3 } })
    expect(rows.flatMap(row => row.insert).find(row => row.id === 'bare')).toEqual({ id: 'bare', name: 'dsh-probe' })
  })

  it('refuses an empty package name', () => {
    const dir = profile()
    expect(() => { registerInstalledPlugin(join(dir, 'cordis.patch.yml'), dir, { id: 'probe', packageName: '  ' }) })
      .toThrow(expect.objectContaining({ code: 'invalid-spec' }))
  })

  it('refuses config that is not a JSON object', () => {
    const dir = profile()
    installPackage(dir, 'dsh-probe')
    const patch = join(dir, 'cordis.patch.yml')
    for (const configJson of ['{', '[]', '3', '"text"', 'null']) {
      expect(() => { registerInstalledPlugin(patch, dir, { id: 'probe', packageName: 'dsh-probe', configJson }) },
        `config ${configJson}`).toThrow(expect.objectContaining({ code: 'invalid-spec' }))
    }
  })

  it('refuses a specifier the profile cannot resolve, before writing any row', () => {
    const dir = profile('# untouched\n')
    expect(() => { registerInstalledPlugin(join(dir, 'cordis.patch.yml'), dir, { id: 'probe', packageName: 'not-installed' }) })
      .toThrow(expect.objectContaining({ code: 'unresolved-package' }))
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe('# untouched\n')
  })

  it('accepts a subpath specifier within an installed package', () => {
    const dir = profile()
    installPackage(dir, 'dsh-probe')
    registerInstalledPlugin(join(dir, 'cordis.patch.yml'), dir, { id: 'probe', packageName: 'dsh-probe/index.js' })
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toContain('dsh-probe/index.js')
  })
})
