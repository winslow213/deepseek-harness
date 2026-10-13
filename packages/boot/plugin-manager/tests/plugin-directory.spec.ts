/** Directory-form plugin installation: materialize under `plugins/<id>`, then register the patch row. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it, onTestFinished } from 'vitest'
import { installPluginDirectory, removePluginDirectory } from '../src/plugin-directory.ts'

const MEBIBYTE = 1024 * 1024

/** A throwaway profile directory, removed when its test ends. */
function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-directory-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  writeFileSync(join(dir, 'package.json'), '{"name":"profile"}')
  return dir
}

/** A throwaway source directory holding `index.ts` and the given package manifest, if any. */
function source(manifest?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-source-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  writeFileSync(join(dir, 'index.ts'), 'export default {}\n')
  if (manifest !== undefined) writeFileSync(join(dir, 'package.json'), manifest)
  return dir
}

/** The inserted rows the profile's patch layer holds. */
function rows(profileDir: string): { id: string; name: string }[] {
  const text = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  return (parse(text) as { insert: { id: string; name: string }[] }[]).flatMap(row => row.insert)
}

describe('installPluginDirectory file-dir', () => {
  it('copies the source tree, seeds a loose manifest, and registers the entry row', () => {
    const dir = profile()
    const from = source()
    installPluginDirectory(dir, { form: 'file-dir', id: 'demo', sourcePath: from })
    expect(readFileSync(join(dir, 'plugins', 'demo', 'index.ts'), 'utf8')).toBe('export default {}\n')
    expect(JSON.parse(readFileSync(join(dir, 'plugins', 'demo', 'package.json'), 'utf8'))).toEqual({ type: 'module' })
    expect(rows(dir)).toEqual([{ id: 'demo', name: pathToFileURL(join(dir, 'plugins', 'demo', 'index.ts')).href }])
  })

  it('keeps the manifest the source directory ships', () => {
    const dir = profile()
    installPluginDirectory(dir, { form: 'file-dir', id: 'demo', sourcePath: source('{"name":"demo-plugin"}') })
    expect(JSON.parse(readFileSync(join(dir, 'plugins', 'demo', 'package.json'), 'utf8'))).toEqual({ name: 'demo-plugin' })
  })

  it('replaces the prior copy wholesale on reinstall', () => {
    const dir = profile()
    installPluginDirectory(dir, { form: 'file-dir', id: 'demo', sourcePath: source() })
    writeFileSync(join(dir, 'plugins', 'demo', 'stale.ts'), 'stale\n')
    installPluginDirectory(dir, { form: 'file-dir', id: 'demo', sourcePath: source() })
    expect(existsSync(join(dir, 'plugins', 'demo', 'stale.ts'))).toBe(false)
    expect(rows(dir)).toHaveLength(1)
  })

  it('refuses a relative source path and a missing directory', () => {
    const dir = profile()
    for (const sourcePath of ['./relative', join(dir, 'absent')]) {
      expect(() => { installPluginDirectory(dir, { form: 'file-dir', id: 'demo', sourcePath }) },
        sourcePath).toThrow(expect.objectContaining({ code: 'invalid-spec' }))
    }
    expect(existsSync(join(dir, 'plugins'))).toBe(false)
  })

  it('leaves a previously installed copy intact when the request is refused', () => {
    const dir = profile()
    installPluginDirectory(dir, { form: 'file-dir', id: 'demo', sourcePath: source() })
    expect(() => { installPluginDirectory(dir, { form: 'file-dir', id: 'demo', sourcePath: './relative' }) })
      .toThrow(expect.objectContaining({ code: 'invalid-spec' }))
    expect(readFileSync(join(dir, 'plugins', 'demo', 'index.ts'), 'utf8')).toBe('export default {}\n')
    expect(rows(dir)).toHaveLength(1)
  })

  it('refuses an id that is not one path-safe segment', () => {
    const dir = profile()
    expect(() => { installPluginDirectory(dir, { form: 'file-dir', id: '../escape', sourcePath: source() }) })
      .toThrow(expect.objectContaining({ code: 'invalid-spec' }))
    expect(existsSync(join(dir, 'plugins'))).toBe(false)
  })
})

describe('installPluginDirectory upload-directory', () => {
  const upload = (path: string, content: string): { path: string; content: string } =>
    ({ path, content: Buffer.from(content).toString('base64') })

  it('materializes nested files, seeds a loose manifest, and registers the entry row', () => {
    const dir = profile()
    installPluginDirectory(dir, {
      form: 'upload-directory', id: 'demo',
      files: [upload('index.ts', 'export default {}\n'), upload('nested/helper.ts', 'export const x = 1\n')],
    })
    expect(readFileSync(join(dir, 'plugins', 'demo', 'index.ts'), 'utf8')).toBe('export default {}\n')
    expect(readFileSync(join(dir, 'plugins', 'demo', 'nested', 'helper.ts'), 'utf8')).toBe('export const x = 1\n')
    expect(JSON.parse(readFileSync(join(dir, 'plugins', 'demo', 'package.json'), 'utf8'))).toEqual({ type: 'module' })
    expect(rows(dir)).toHaveLength(1)
  })

  it('refuses an empty upload', () => {
    const dir = profile()
    expect(() => { installPluginDirectory(dir, { form: 'upload-directory', id: 'demo', files: [] }) })
      .toThrow(expect.objectContaining({ code: 'invalid-spec' }))
  })

  it('refuses every path that could leave the plugin directory', () => {
    const dir = profile()
    for (const path of ['', '.', '..', '/absolute', '../escape', 'a/../b', 'a/./b', 'a//b', 'a\\b', 'C:x', 'a\0b']) {
      expect(() => { installPluginDirectory(dir, { form: 'upload-directory', id: 'demo', files: [upload(path, 'x')] }) },
        `path ${JSON.stringify(path)}`).toThrow(expect.objectContaining({ code: 'invalid-spec' }))
    }
  })

  it('refuses a payload that is not base64', () => {
    const dir = profile()
    expect(() => {
      installPluginDirectory(dir, { form: 'upload-directory', id: 'demo', files: [{ path: 'index.ts', content: 'not base64!' }] })
    }).toThrow(expect.objectContaining({ code: 'invalid-spec' }))
  })

  it('refuses a file over the per-file byte ceiling', () => {
    const dir = profile()
    expect(() => {
      installPluginDirectory(dir, {
        form: 'upload-directory', id: 'demo',
        files: [{ path: 'big.ts', content: Buffer.alloc(MEBIBYTE + 1).toString('base64') }],
      })
    }).toThrow(expect.objectContaining({ code: 'upload-too-large' }))
  })

  it('accepts a file exactly at the per-file byte ceiling', () => {
    const dir = profile()
    installPluginDirectory(dir, {
      form: 'upload-directory', id: 'demo',
      files: [{ path: 'big.ts', content: Buffer.alloc(MEBIBYTE).toString('base64') }],
    })
    expect(readFileSync(join(dir, 'plugins', 'demo', 'big.ts')).length).toBe(MEBIBYTE)
  })

  it('refuses more files than the count ceiling', () => {
    const dir = profile()
    const files = Array.from({ length: 513 }, (_value, index) => upload(`f${String(index)}.ts`, 'x'))
    expect(() => { installPluginDirectory(dir, { form: 'upload-directory', id: 'demo', files }) })
      .toThrow(expect.objectContaining({ code: 'upload-too-many-files' }))
  })

  it('refuses a directory over the total byte ceiling', () => {
    const dir = profile()
    const one = Buffer.alloc(MEBIBYTE).toString('base64')
    const files = Array.from({ length: 11 }, (_value, index) => ({ path: `f${String(index)}.ts`, content: one }))
    expect(() => { installPluginDirectory(dir, { form: 'upload-directory', id: 'demo', files }) })
      .toThrow(expect.objectContaining({ code: 'upload-too-large' }))
  })
})

describe('removePluginDirectory', () => {
  it('removes the row and the copied directory', async () => {
    const dir = profile()
    installPluginDirectory(dir, { form: 'file-dir', id: 'demo', sourcePath: source() })
    expect(await removePluginDirectory(dir, 'demo')).toBe(true)
    expect(existsSync(join(dir, 'plugins', 'demo'))).toBe(false)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).not.toContain('demo')
  })

  it('reports an id with no row and leaves other rows alone', async () => {
    const dir = profile()
    mkdirSync(join(dir, 'plugins'), { recursive: true })
    installPluginDirectory(dir, { form: 'file-dir', id: 'kept', sourcePath: source() })
    expect(await removePluginDirectory(dir, 'absent')).toBe(false)
    expect(rows(dir)).toHaveLength(1)
  })

  it('refuses an id that is not one path-safe segment', async () => {
    const dir = profile()
    await expect(removePluginDirectory(dir, 'a/b')).rejects.toThrow(expect.objectContaining({ code: 'invalid-spec' }))
  })
})
