/**
 * The runtime copy lists in `../src/remote/inject.ts` drive `cpSync` of
 * source modules into each account's DSH_HOME, where cordis loads them
 * directly. A module that imports a sibling missing from its list does not
 * fail at type-check or build time — it fails when the account's instance
 * boots, which is the worst possible place to find out. These cases derive
 * the requirement from the actual import statements instead of restating the
 * lists, so the lists cannot drift out of sync again.
 *
 * Only runtime imports count: a type-only import (`import type { X }` or an
 * inline `type X` in the specifier list) is erased before the module is
 * loaded, so its target need not be copied.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  KB_SEARCH_RUNTIME_FILES,
  REMOTE_RUNTIME_FILES,
  WIKI_RUNTIME_FILES,
} from '../src/remote/inject.ts'

const REMOTE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'remote')

/**
 * Relative module specifiers a source file imports at runtime (local imports
 * carry a `.ts` extension in this repo's NodeNext ESM layout). Type-only
 * imports are skipped: `import type` lines entirely, and named imports whose
 * every binding is inline-`type`.
 * @param file - a filename inside `shell/src/remote`.
 */
function runtimeImportsOf(file: string): string[] {
  const text = readFileSync(join(REMOTE_DIR, file), 'utf8')
  const found: string[] = []
  for (const match of text.matchAll(/^import\s+(?<clause>[^'"]*?)'\.\/(?<specifier>[^']+)'/gm)) {
    if (match.groups?.specifier === undefined) continue
    const clause = (match.groups.clause ?? '').trim()
    if (clause.startsWith('type ')) continue
    // `import { type A, type B } from './x.ts'` is also erased whole.
    const braced = /^\{(?<names>[^}]*)\}$/.exec(clause)
    if (braced?.groups?.names !== undefined) {
      const names = braced.groups.names.split(',').map(name => name.trim()).filter(name => name !== '')
      if (names.length > 0 && names.every(name => name.startsWith('type '))) continue
    }
    if (match.groups.specifier.endsWith('.ts')) found.push(match.groups.specifier)
  }
  return found
}

/** Every module a copied file needs at runtime, transitively. */
function requiredClosure(files: readonly string[]): Set<string> {
  const required = new Set<string>()
  const seen = new Set<string>()
  const queue = [...files]
  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    for (const imported of runtimeImportsOf(file)) {
      if (!files.includes(imported)) required.add(imported)
      queue.push(imported)
    }
  }
  return required
}

const LISTS = [
  { name: 'REMOTE_RUNTIME_FILES', files: REMOTE_RUNTIME_FILES },
  { name: 'WIKI_RUNTIME_FILES', files: WIKI_RUNTIME_FILES },
  { name: 'KB_SEARCH_RUNTIME_FILES', files: KB_SEARCH_RUNTIME_FILES },
] as const

describe('runtime copy lists are transitively complete', () => {
  for (const { name, files } of LISTS) {
    it(`${name} copies every module its files import at runtime`, () => {
      const missing = [...requiredClosure(files)].sort()
      assert.deepEqual(
        missing,
        [],
        `${name} omits runtime-imported modules (each would break the account's instance at boot): ${missing.join(', ')}`,
      )
    })
  }

  it('ignores type-only imports, which are erased before load', () => {
    // `client.ts` type-imports hub.ts; hub.ts must NOT be required in the
    // copy list, or every account would ship an unnecessary module (and the
    // check would nag about a non-problem).
    assert.equal(runtimeImportsOf('client.ts').includes('hub.ts'), false)
  })

  it('detects a deliberately incomplete list (guards the guard)', () => {
    // Proves the check above can actually fail, rather than passing vacuously
    // if the import regex ever stops matching: wiki-tool.ts genuinely
    // runtime-imports its wiki-fs.ts sibling.
    assert.ok(
      requiredClosure(['wiki-tool.ts']).has('wiki-fs.ts'),
      'expected the checker to flag wiki-fs.ts as missing',
    )
  })
})
