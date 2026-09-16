import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scaffoldUserWiki,
  writeWikiLayer,
  wikiPaths,
  WIKI_IDENTITY_FILE,
  WIKI_PREFERENCES_FILE,
  WIKI_TIMELINE_FILE,
  WIKI_DECISIONS_FILE,
} from '../src/remote/wiki-fs.ts'

describe('scaffoldUserWiki', () => {
  it('creates all four layer files with skeleton content when absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      scaffoldUserWiki(root)
      assert.ok(existsSync(join(root, WIKI_IDENTITY_FILE)))
      assert.ok(existsSync(join(root, WIKI_PREFERENCES_FILE)))
      assert.ok(existsSync(join(root, WIKI_TIMELINE_FILE)))
      assert.ok(existsSync(join(root, WIKI_DECISIONS_FILE)))
      const identity = await readFile(join(root, WIKI_IDENTITY_FILE), 'utf8')
      assert.match(identity, /Identity/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never overwrites an existing file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      scaffoldUserWiki(root)
      writeWikiLayer(root, 'identity', { title: '', content: 'custom identity content' })
      scaffoldUserWiki(root)
      const identity = await readFile(join(root, WIKI_IDENTITY_FILE), 'utf8')
      assert.equal(identity, 'custom identity content\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('writeWikiLayer', () => {
  it('overwrites identity/preferences whole rather than appending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      writeWikiLayer(root, 'preferences', { title: '', content: 'first' })
      writeWikiLayer(root, 'preferences', { title: '', content: 'second' })
      const content = await readFile(wikiPaths(root).preferences, 'utf8')
      assert.equal(content, 'second\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('appends timeline entries without touching earlier ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      writeWikiLayer(root, 'timeline', { title: 'first breakthrough', content: 'did the thing' })
      writeWikiLayer(root, 'timeline', { title: 'second breakthrough', content: 'did another thing' })
      const content = await readFile(wikiPaths(root).timeline, 'utf8')
      assert.match(content, /first breakthrough/)
      assert.match(content, /second breakthrough/)
      assert.ok(content.indexOf('first breakthrough') < content.indexOf('second breakthrough'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('appends decision entries with alternatives considered and decided-by', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    try {
      writeWikiLayer(root, 'decision', {
        title: 'chose approach A',
        content: 'went with A because it is simpler',
        alternativesConsidered: 'B was rejected for higher complexity',
        decidedBy: 'joint',
      })
      const content = await readFile(wikiPaths(root).decisions, 'utf8')
      assert.match(content, /chose approach A/)
      assert.match(content, /B was rejected for higher complexity/)
      assert.match(content, /joint/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('creates the workspace root and log subdirectory on demand', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-wiki-'))
    const root = join(parent, 'nested', 'workspace')
    try {
      writeWikiLayer(root, 'decision', { title: 't', content: 'c', alternativesConsidered: 'a' })
      assert.ok(existsSync(wikiPaths(root).decisions))
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})
