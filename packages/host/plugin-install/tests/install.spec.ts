/**
 * Plugin install gateway tests: the operator-gated Remote that installs
 * external plugins into a dsh profile — file-dir copies and patch rows, plus
 * npm-bundle `pnpm add` and bundle-layer reconciliation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import {
  mountRootInclude,
  PROFILE_PATCH_FILENAME,
  readProfileManifest,
  writeProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import PluginInstallGateway from '../src/index.ts'
import type { PluginInstallSpec } from '../src/index.ts'

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}))

const contexts: Context[] = []

/**
 * Capture the synchronous failure of one install call; the gateway rejects
 * invalid specs before running them.
 */
function installError(gateway: PluginInstallGateway, spec: PluginInstallSpec): unknown {
  try {
    gateway.installPlugin(spec)
  } catch (error) {
    return error
  }
  return undefined
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.mocked(spawnSync).mockReset()
})

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-plugin-install-'))

/** Stage a fake bundle package under a node_modules root. */
function stageBundle(root: string, name: string): void {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '0.0.0',
    type: 'module',
    main: './index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(dir, 'index.js'), `export const packageName = ${JSON.stringify(name)}\n`)
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
}

/** The base64 form of a UTF-8 payload, as the browser upload channel sends it. */
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

async function harness(profileDir: string): Promise<{ ctx: Context; gateway: PluginInstallGateway }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  await ctx.plugin(PluginInstallGateway, { enabled: true, profileDir })
  return { ctx, gateway: ctx.get('pluginInstall') as PluginInstallGateway }
}

describe('PluginInstallGateway', () => {
  it('publishes the install and upload methods under the pluginInstall namespace', async () => {
    const { gateway } = await harness(tmp())
    expect(gateway.typertRemote).toMatchObject({
      serviceKey: 'pluginInstall',
      namespace: 'pluginInstall',
    })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'installPlugin', invocation: { kind: 'direct' } },
      { method: 'uploadDirectory', invocation: { kind: 'direct' } },
    ])
  })

  it('refuses to mount when the operator switch is off', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    await expect(ctx.plugin(PluginInstallGateway, { enabled: false, profileDir: tmp() })).rejects.toThrow(
      /enabled: true/,
    )
  })

  it('copies a source directory and registers its patch row', async () => {
    const profileDir = tmp()
    const sourceDir = tmp()
    writeFileSync(join(sourceDir, 'index.ts'), 'export const region = "r1"\n')
    const { gateway } = await harness(profileDir)

    const result = gateway.installPlugin({ form: 'file-dir', id: 'region-router', sourcePath: sourceDir })
    expect(result).toEqual({ form: 'file-dir', profileDir, pluginId: 'region-router' })

    // The copy landed under plugins/<id>.
    expect(readFileSync(join(profileDir, 'plugins', 'region-router', 'index.ts'), 'utf8'))
      .toBe('export const region = "r1"\n')
    // A directory without a manifest gets the loose plugin manifest.
    expect(JSON.parse(readFileSync(join(profileDir, 'plugins', 'region-router', 'package.json'), 'utf8')))
      .toEqual({ type: 'module' })

    const patch = readFileSync(join(profileDir, PROFILE_PATCH_FILENAME), 'utf8')
    expect(patch).toContain('# >>> dsh-plugin-install region-router')
    expect(patch).toContain('- insert:')
    expect(patch).toContain('- id: region-router')
    const moduleUrl = pathToFileURL(join(profileDir, 'plugins', 'region-router', 'index.ts')).href
    expect(patch).toContain(`name: ${JSON.stringify(moduleUrl)}`)
    expect(patch).toContain('# <<< dsh-plugin-install region-router')
  })

  it('keeps a source-provided package.json instead of writing the loose marker', async () => {
    const profileDir = tmp()
    const sourceDir = tmp()
    writeFileSync(join(sourceDir, 'index.ts'), 'export const plugin = true\n')
    writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ name: 'region-router', type: 'module' }))
    const { gateway } = await harness(profileDir)

    gateway.installPlugin({ form: 'file-dir', id: 'region-router', sourcePath: sourceDir })
    expect(JSON.parse(readFileSync(join(profileDir, 'plugins', 'region-router', 'package.json'), 'utf8')))
      .toEqual({ name: 'region-router', type: 'module' })
  })

  it('replaces the prior patch row on reinstall without duplicating', async () => {
    const profileDir = tmp()
    const sourceDir = tmp()
    const { gateway } = await harness(profileDir)
    writeFileSync(join(sourceDir, 'index.ts'), 'export const version = 1\n')
    gateway.installPlugin({ form: 'file-dir', id: 'region-router', sourcePath: sourceDir })
    writeFileSync(join(sourceDir, 'index.ts'), 'export const version = 2\n')
    gateway.installPlugin({ form: 'file-dir', id: 'region-router', sourcePath: sourceDir })

    const patch = readFileSync(join(profileDir, PROFILE_PATCH_FILENAME), 'utf8')
    expect(patch.match(/- id: region-router/g)).toHaveLength(1)
    expect(readFileSync(join(profileDir, 'plugins', 'region-router', 'index.ts'), 'utf8'))
      .toBe('export const version = 2\n')
  })

  it('preserves unrelated user rows and comments when inserting a patch row', async () => {
    const profileDir = tmp()
    const sourceDir = tmp()
    writeFileSync(join(sourceDir, 'index.ts'), 'export const plugin = true\n')
    const userRow = '# user-owned row\n- id: my-row\n  config:\n    value: 1\n'
    writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), userRow)
    const { gateway } = await harness(profileDir)

    gateway.installPlugin({ form: 'file-dir', id: 'region-router', sourcePath: sourceDir })
    const patch = readFileSync(join(profileDir, PROFILE_PATCH_FILENAME), 'utf8')
    expect(patch).toContain(userRow.trimEnd())
    expect(patch.match(/- insert:/g)).toHaveLength(1)
  })

  it('rejects an id that could escape the plugins directory', async () => {
    const { gateway } = await harness(tmp())
    expect(installError(gateway, { form: 'file-dir', id: '../escape', sourcePath: tmp() })).toMatchObject({
      code: 'plugin-install/invalid-spec',
    })
  })

  it('rejects a relative source path and a missing source directory', async () => {
    const { gateway } = await harness(tmp())
    expect(installError(gateway, { form: 'file-dir', id: 'ok', sourcePath: 'relative/path' })).toMatchObject({
      code: 'plugin-install/invalid-spec',
    })
    expect(installError(gateway, { form: 'file-dir', id: 'ok', sourcePath: join(tmp(), 'missing') })).toMatchObject({
      code: 'plugin-install/invalid-spec',
    })
  })

  it('materializes an uploaded directory and registers its patch row', async () => {
    const profileDir = tmp()
    const { gateway } = await harness(profileDir)

    const result = gateway.uploadDirectory({
      form: 'upload-directory',
      id: 'region-router',
      files: [
        { path: 'src/router.ts', content: b64('export const route = "/r1"\n') },
        { path: 'index.ts', content: b64('export * from "./src/router.ts"\n') },
      ],
    })
    expect(result).toEqual({ form: 'upload-directory', profileDir, pluginId: 'region-router' })

    expect(readFileSync(join(profileDir, 'plugins', 'region-router', 'src', 'router.ts'), 'utf8'))
      .toBe('export const route = "/r1"\n')
    expect(readFileSync(join(profileDir, 'plugins', 'region-router', 'index.ts'), 'utf8'))
      .toBe('export * from "./src/router.ts"\n')
    // A directory without a manifest gets the loose plugin manifest.
    expect(JSON.parse(readFileSync(join(profileDir, 'plugins', 'region-router', 'package.json'), 'utf8')))
      .toEqual({ type: 'module' })

    const patch = readFileSync(join(profileDir, PROFILE_PATCH_FILENAME), 'utf8')
    expect(patch).toContain('# >>> dsh-plugin-install region-router')
    expect(patch).toContain('- id: region-router')
    const moduleUrl = pathToFileURL(join(profileDir, 'plugins', 'region-router', 'index.ts')).href
    expect(patch).toContain(`name: ${JSON.stringify(moduleUrl)}`)
  })

  it('keeps a source-provided package.json on an uploaded directory', async () => {
    const profileDir = tmp()
    const { gateway } = await harness(profileDir)

    gateway.uploadDirectory({
      form: 'upload-directory',
      id: 'region-router',
      files: [
        { path: 'index.ts', content: b64('export const plugin = true\n') },
        { path: 'package.json', content: b64(JSON.stringify({ name: 'region-router', type: 'module' })) },
      ],
    })
    expect(JSON.parse(readFileSync(join(profileDir, 'plugins', 'region-router', 'package.json'), 'utf8')))
      .toEqual({ name: 'region-router', type: 'module' })
  })

  it('replaces the prior upload on reinstall without duplicating the patch row', async () => {
    const profileDir = tmp()
    const { gateway } = await harness(profileDir)
    gateway.uploadDirectory({
      form: 'upload-directory',
      id: 'region-router',
      files: [{ path: 'index.ts', content: b64('export const version = 1\n') }],
    })
    gateway.uploadDirectory({
      form: 'upload-directory',
      id: 'region-router',
      files: [{ path: 'index.ts', content: b64('export const version = 2\n') }],
    })

    const patch = readFileSync(join(profileDir, PROFILE_PATCH_FILENAME), 'utf8')
    expect(patch.match(/- id: region-router/g)).toHaveLength(1)
    expect(readFileSync(join(profileDir, 'plugins', 'region-router', 'index.ts'), 'utf8'))
      .toBe('export const version = 2\n')
  })

  it('rejects an uploaded directory that is empty or carries too many files', async () => {
    const { gateway } = await harness(tmp())
    expect(installError(gateway, { form: 'upload-directory', id: 'ok', files: [] })).toMatchObject({
      code: 'plugin-install/invalid-spec',
    })
    expect(installError(gateway, {
      form: 'upload-directory',
      id: 'ok',
      files: Array.from({ length: 513 }, (_, index) => ({ path: `f${index}.ts`, content: b64('x') })),
    })).toMatchObject({
      code: 'plugin-install/upload-too-many-files',
      details: { maxFiles: 512, fileCount: 513 },
    })
  })

  it('rejects an uploaded path that could escape the plugins directory', async () => {
    const { gateway } = await harness(tmp())
    for (const path of ['../escape', 'a/../../b', '/abs', 'a\\b']) {
      expect(installError(gateway, {
        form: 'upload-directory',
        id: 'ok',
        files: [{ path, content: b64('x') }],
      })).toMatchObject({ code: 'plugin-install/invalid-spec' })
    }
  })

  it('rejects an uploaded file that is not valid base64 or exceeds the file ceiling', async () => {
    const { gateway } = await harness(tmp())
    expect(installError(gateway, {
      form: 'upload-directory',
      id: 'ok',
      files: [{ path: 'a.ts', content: 'not base64!!' }],
    })).toMatchObject({ code: 'plugin-install/invalid-spec' })
    const oneMegabyte = Buffer.alloc(1024 * 1024 + 1, 0x61)
    expect(installError(gateway, {
      form: 'upload-directory',
      id: 'ok',
      files: [{ path: 'big.ts', content: oneMegabyte.toString('base64') }],
    })).toMatchObject({
      code: 'plugin-install/upload-too-large',
      details: { maxBytes: 1024 * 1024, actualBytes: 1024 * 1024 + 1 },
    })
  })

  it('rejects an upload whose decoded total exceeds the aggregate ceiling', async () => {
    const { gateway } = await harness(tmp())
    const oneMegabyte = Buffer.alloc(1024 * 1024, 0x61).toString('base64')
    expect(installError(gateway, {
      form: 'upload-directory',
      id: 'ok',
      files: Array.from({ length: 11 }, (_, index) => ({ path: `f${index}.bin`, content: oneMegabyte })),
    })).toMatchObject({
      code: 'plugin-install/upload-too-large',
      details: { maxBytes: 10 * 1024 * 1024, actualBytes: 11 * 1024 * 1024 },
    })
  })

  it('reports a filesystem write failure on an uploaded directory', async () => {
    const { gateway } = await harness(tmp())
    // The second file's parent segment was already written as a plain file.
    expect(installError(gateway, {
      form: 'upload-directory',
      id: 'ok',
      files: [
        { path: 'block', content: b64('file') },
        { path: 'block/inner.ts', content: b64('x') },
      ],
    })).toMatchObject({ code: 'plugin-install/write-failed' })
  })

  it('promotes a newly installed bundle dependency into the layer stack', async () => {
    const profileDir = tmp()
    const { gateway } = await harness(profileDir)

    vi.mocked(spawnSync).mockImplementation((_command, args, options) => {
      // Simulate `pnpm add external-bundle`: write the dependency and materialize the package.
      const dir = (options as { cwd: string }).cwd
      const name = args![1]!
      writeProfileManifest(dir, {
        name: `dsh-profile-${basename(dir)}`,
        dependencies: { [name]: '0.0.0' },
      })
      stageBundle(dir, name)
      return { status: 0, signal: null, pid: 1, output: [], stdout: '', stderr: '' }
    })

    const result = gateway.installPlugin({ form: 'npm-bundle', spec: 'external-bundle' })
    expect(result).toEqual({ form: 'npm-bundle', profileDir, bundlesAdded: ['external-bundle'] })
    expect(readProfileManifest('dsh', profileDir).dsh?.profile?.bundles).toEqual(['external-bundle'])
  })

  it('initializes a bare profile directory before the pnpm add', async () => {
    const profileDir = tmp()
    const { gateway } = await harness(profileDir)
    expect(existsSync(join(profileDir, 'package.json'))).toBe(false)

    vi.mocked(spawnSync).mockImplementation((_command, _args, options) => {
      const dir = (options as { cwd: string }).cwd
      writeProfileManifest(dir, { name: 'dsh-profile-test', dependencies: {} })
      return { status: 0, signal: null, pid: 1, output: [], stdout: '', stderr: '' }
    })

    gateway.installPlugin({ form: 'npm-bundle', spec: 'plain-lib' })
    // initProfile ran before pnpm: the profile now owns a manifest and patch layer.
    expect(readProfileManifest('dsh', profileDir).dependencies ?? {}).toEqual({})
    expect(existsSync(join(profileDir, PROFILE_PATCH_FILENAME))).toBe(true)
  })

  it('rejects an empty npm spec', async () => {
    const { gateway } = await harness(tmp())
    expect(installError(gateway, { form: 'npm-bundle', spec: '   ' })).toMatchObject({
      code: 'plugin-install/invalid-spec',
    })
  })

  it('extracts the package spec from a full dsh plugin add command', async () => {
    const profileDir = tmp()
    const { gateway } = await harness(profileDir)

    vi.mocked(spawnSync).mockImplementation((_command, _args, options) => {
      const dir = (options as { cwd: string }).cwd
      writeProfileManifest(dir, { name: `dsh-profile-${basename(dir)}`, dependencies: { external: '0.0.0' } })
      stageBundle(dir, 'external')
      return { status: 0, signal: null, pid: 1, output: [], stdout: '', stderr: '' }
    })

    const result = gateway.installPlugin({
      form: 'npm-bundle',
      spec: 'dsh plugin --profile web add external',
    })
    expect(vi.mocked(spawnSync).mock.calls[0]![1]).toEqual(['add', 'external'])
    expect(result).toEqual({ form: 'npm-bundle', profileDir, bundlesAdded: ['external'] })
  })

  it('extracts the package spec from a pnpm add command and strips quotes', async () => {
    const { gateway } = await harness(tmp())
    vi.mocked(spawnSync).mockImplementation((_command, _args, options) => {
      const dir = (options as { cwd: string }).cwd
      writeProfileManifest(dir, { name: 'dsh-profile-test', dependencies: { '@scope/pkg': '1.2.0' } })
      return { status: 0, signal: null, pid: 1, output: [], stdout: '', stderr: '' }
    })

    gateway.installPlugin({ form: 'npm-bundle', spec: "pnpm add '@scope/pkg@^1.2.0'" })
    expect(vi.mocked(spawnSync).mock.calls[0]![1]).toEqual(['add', '@scope/pkg@^1.2.0'])
  })

  it('forwards a bare package spec untouched when it carries no add command', async () => {
    const { gateway } = await harness(tmp())
    vi.mocked(spawnSync).mockImplementation((_command, _args, options) => {
      const dir = (options as { cwd: string }).cwd
      writeProfileManifest(dir, { name: 'dsh-profile-test', dependencies: { 'add-ons': '0.0.0' } })
      return { status: 0, signal: null, pid: 1, output: [], stdout: '', stderr: '' }
    })

    // The bare spec contains the word `add` glued to other characters, so it
    // must survive as-is rather than being mistaken for a command.
    gateway.installPlugin({ form: 'npm-bundle', spec: 'add-ons' })
    expect(vi.mocked(spawnSync).mock.calls[0]![1]).toEqual(['add', 'add-ons'])
  })

  it('passes an incomplete add command through to pnpm as-is', async () => {
    const { gateway } = await harness(tmp())
    vi.mocked(spawnSync).mockImplementation((_command, _args, options) => {
      const dir = (options as { cwd: string }).cwd
      writeProfileManifest(dir, { name: 'dsh-profile-test', dependencies: {} })
      return { status: 0, signal: null, pid: 1, output: [], stdout: '', stderr: '' }
    })

    gateway.installPlugin({ form: 'npm-bundle', spec: 'pnpm add' })
    expect(vi.mocked(spawnSync).mock.calls[0]![1]).toEqual(['add', 'pnpm add'])
  })

  it('reports a missing pnpm executable', async () => {
    const { gateway } = await harness(tmp())
    vi.mocked(spawnSync).mockReturnValue({
      status: null,
      signal: null,
      pid: 0,
      output: [],
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }),
    })
    expect(installError(gateway, { form: 'npm-bundle', spec: 'any-package' })).toMatchObject({
      code: 'plugin-install/pnpm-missing',
    })
  })

  it('reports a non-zero pnpm add exit with pnpm diagnostic output', async () => {
    const { gateway } = await harness(tmp())
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      signal: null,
      pid: 1,
      output: [],
      stdout: '',
      stderr: 'ERR_PNPM_IGNORED_BUILDS Ignored build scripts: node-pty@1.1.0',
    })
    expect(installError(gateway, { form: 'npm-bundle', spec: 'missing-package' })).toMatchObject({
      code: 'plugin-install/pnpm-failed',
      details: {
        profileDir: expect.any(String) as string,
        exitCode: 1,
        output: 'ERR_PNPM_IGNORED_BUILDS Ignored build scripts: node-pty@1.1.0',
      },
    })
  })

  it('approves the builds pnpm refused and retries the pnpm add once', async () => {
    const profileDir = tmp()
    const { gateway } = await harness(profileDir)
    writeProfileManifest(profileDir, { name: `dsh-profile-${basename(profileDir)}`, dependencies: {} })
    const workspaceYaml = join(profileDir, 'pnpm-workspace.yaml')
    // pnpm ≥10 writes this invalid placeholder into a profile with no map.
    writeFileSync(workspaceYaml, 'allowBuilds:\n  node-pty: set this to true or false\n')

    let calls = 0
    vi.mocked(spawnSync).mockImplementation((_command, _args, options) => {
      calls += 1
      // First invocation: pnpm refuses the node-pty build script.
      if (calls === 1) {
        return {
          status: 1,
          signal: null,
          pid: 1,
          output: [],
          stdout: 'Progress: done\n[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: node-pty@1.1.0\n',
          stderr: '',
        }
      }
      // Second invocation (the retry): the approval landed, install succeeds.
      const dir = (options as { cwd: string }).cwd
      writeProfileManifest(dir, { name: `dsh-profile-${basename(dir)}`, dependencies: { external: '0.0.0' } })
      stageBundle(dir, 'external')
      return { status: 0, signal: null, pid: 1, output: [], stdout: '', stderr: '' }
    })

    const result = gateway.installPlugin({ form: 'npm-bundle', spec: 'external' })
    expect(calls).toBe(2)
    expect(result).toEqual({ form: 'npm-bundle', profileDir, bundlesAdded: ['external'] })
    // The placeholder became a real approval, so the next add succeeds.
    expect(readFileSync(workspaceYaml, 'utf8')).toContain('  node-pty: true')
  })

  it('rebuilds a native binding whose refusal predates a short-circuited add', async () => {
    const profileDir = tmp()
    const { gateway } = await harness(profileDir)
    writeProfileManifest(profileDir, { name: `dsh-profile-${basename(profileDir)}`, dependencies: { external: '0.0.0' } })
    stageBundle(profileDir, 'external')
    const workspaceYaml = join(profileDir, 'pnpm-workspace.yaml')
    // An earlier failed add left pnpm's placeholder; this add resolves from the
    // existing lockfile and exits 0 without ever retrying the refused build.
    writeFileSync(workspaceYaml, 'allowBuilds:\n  node-pty: set this to true or false\n')

    const calls: string[][] = []
    vi.mocked(spawnSync).mockImplementation((_command, args) => {
      calls.push([...(args ?? [])])
      return { status: 0, signal: null, pid: 1, output: [], stdout: '', stderr: '' }
    })

    const result = gateway.installPlugin({ form: 'npm-bundle', spec: 'external' })
    // add succeeded (short-circuited), then the leftover refusal triggered a rebuild.
    expect(calls).toEqual([['add', 'external'], ['rebuild', 'node-pty']])
    expect(result).toEqual({ form: 'npm-bundle', profileDir, bundlesAdded: ['external'] })
    expect(readFileSync(workspaceYaml, 'utf8')).toContain('  node-pty: true')
  })

  it('registers a startup row for an installed npm plugin without config', async () => {
    const profileDir = tmp()
    const { gateway } = await harness(profileDir)
    writeProfileManifest(profileDir, { name: 'dsh-profile-register', dependencies: { 'dsh-demo-plugin': '1.0.0' } })
    const pkgDir = join(profileDir, 'node_modules', 'dsh-demo-plugin')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-demo-plugin', version: '1.0.0', main: './index.js' }))
    writeFileSync(join(pkgDir, 'index.js'), 'export const apply = () => {}\n')

    const result = gateway.installPlugin({ form: 'npm-register', id: 'demo', packageName: 'dsh-demo-plugin' })
    expect(result).toEqual({ form: 'npm-register', profileDir, pluginId: 'demo' })
    const patch = readFileSync(join(profileDir, PROFILE_PATCH_FILENAME), 'utf8')
    expect(patch).toContain('# >>> dsh-plugin-install demo')
    expect(patch).toContain('- insert:')
    expect(patch).toContain('- id: demo')
    expect(patch).toContain('name: dsh-demo-plugin')
    expect(patch).not.toContain('config:')
    expect(patch).toContain('# <<< dsh-plugin-install demo')
  })

  it('registers a startup row with JSON config rendered as YAML', async () => {
    const profileDir = tmp()
    const { gateway } = await harness(profileDir)
    writeProfileManifest(profileDir, { name: 'dsh-profile-register', dependencies: { 'dsh-demo-plugin': '1.0.0' } })
    const pkgDir = join(profileDir, 'node_modules', 'dsh-demo-plugin')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-demo-plugin', version: '1.0.0', main: './index.js' }))
    writeFileSync(join(pkgDir, 'index.js'), 'export const apply = () => {}\n')

    const result = gateway.installPlugin({
      form: 'npm-register',
      id: 'demo',
      packageName: 'dsh-demo-plugin',
      configJson: '{ "region": "cn-east", "count": 3, "nested": { "flag": true } }',
    })
    expect(result).toEqual({ form: 'npm-register', profileDir, pluginId: 'demo' })
    const patch = readFileSync(join(profileDir, PROFILE_PATCH_FILENAME), 'utf8')
    expect(patch).toContain('- id: demo')
    expect(patch).toContain('name: dsh-demo-plugin')
    expect(patch).toContain('config:')
    expect(patch).toContain('region: cn-east')
    expect(patch).toContain('count: 3')
    expect(patch).toContain('flag: true')
  })

  it('replaces the prior register row on re-register without duplicating', async () => {
    const profileDir = tmp()
    const { gateway } = await harness(profileDir)
    writeProfileManifest(profileDir, { name: 'dsh-profile-register', dependencies: { 'dsh-demo-plugin': '1.0.0' } })
    const pkgDir = join(profileDir, 'node_modules', 'dsh-demo-plugin')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-demo-plugin', version: '1.0.0', main: './index.js' }))
    writeFileSync(join(pkgDir, 'index.js'), 'export const apply = () => {}\n')
    gateway.installPlugin({ form: 'npm-register', id: 'demo', packageName: 'dsh-demo-plugin', configJson: '{ "v": 1 }' })

    gateway.installPlugin({ form: 'npm-register', id: 'demo', packageName: 'dsh-demo-plugin', configJson: '{ "v": 2 }' })

    const patch = readFileSync(join(profileDir, PROFILE_PATCH_FILENAME), 'utf8')
    expect(patch.match(/- id: demo/g)).toHaveLength(1)
    expect(patch).toContain('v: 2')
    expect(patch).not.toContain('v: 1')
  })

  it('rejects a register request for a package that is not installed', async () => {
    const { gateway } = await harness(tmp())
    expect(installError(gateway, { form: 'npm-register', id: 'demo', packageName: 'dsh-missing-plugin' })).toMatchObject({
      code: 'plugin-install/unresolved-package',
    })
  })

  it('rejects a register request with invalid or non-object JSON config', async () => {
    const profileDir = tmp()
    const { gateway } = await harness(profileDir)
    writeProfileManifest(profileDir, { name: 'dsh-profile-register', dependencies: { 'dsh-demo-plugin': '1.0.0' } })
    const pkgDir = join(profileDir, 'node_modules', 'dsh-demo-plugin')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-demo-plugin', version: '1.0.0', main: './index.js' }))
    writeFileSync(join(pkgDir, 'index.js'), 'export const apply = () => {}\n')

    const bad = (configJson: string): unknown => installError(gateway, {
      form: 'npm-register', id: 'demo', packageName: 'dsh-demo-plugin', configJson,
    })
    expect(bad('{ nope')).toMatchObject({ code: 'plugin-install/invalid-spec' })
    expect(bad('[1, 2]')).toMatchObject({ code: 'plugin-install/invalid-spec' })
    expect(bad('42')).toMatchObject({ code: 'plugin-install/invalid-spec' })
    // Blank config is accepted: it registers the row without a config key.
    expect(bad('  ')).toBeUndefined()
  })

  it('rejects a register request whose id or package name is empty', async () => {
    const profileDir = tmp()
    const { gateway } = await harness(profileDir)
    writeProfileManifest(profileDir, { name: 'dsh-profile-register', dependencies: { 'dsh-demo-plugin': '1.0.0' } })
    const pkgDir = join(profileDir, 'node_modules', 'dsh-demo-plugin')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-demo-plugin', version: '1.0.0', main: './index.js' }))
    expect(installError(gateway, { form: 'npm-register', id: '../escape', packageName: 'dsh-demo-plugin' })).toMatchObject({
      code: 'plugin-install/invalid-spec',
    })
    expect(installError(gateway, { form: 'npm-register', id: 'demo', packageName: '  ' })).toMatchObject({
      code: 'plugin-install/invalid-spec',
    })
  })

  it('registers a scoped subpath specifier that resolves', async () => {
    const profileDir = tmp()
    const { gateway } = await harness(profileDir)
    writeProfileManifest(profileDir, { name: 'dsh-profile-register', dependencies: { '@scope/demo': '1.0.0' } })
    const pkgDir = join(profileDir, 'node_modules', '@scope', 'demo')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@scope/demo', version: '1.0.0', main: './index.js',
      exports: { './plugin': './plugin.js', '.': './index.js' },
    }))
    writeFileSync(join(pkgDir, 'index.js'), 'export const apply = () => {}\n')
    writeFileSync(join(pkgDir, 'plugin.js'), 'export const apply = () => {}\n')

    const result = gateway.installPlugin({ form: 'npm-register', id: 'scoped', packageName: '@scope/demo/plugin' })
    expect(result).toEqual({ form: 'npm-register', profileDir, pluginId: 'scoped' })
    const patch = readFileSync(join(profileDir, PROFILE_PATCH_FILENAME), 'utf8')
    expect(patch).toContain("name: '@scope/demo/plugin'")
  })

  it('self-locates the profile directory from the bootstrap include entry', async () => {
    const profileDir = tmp()
    writeFileSync(join(profileDir, 'noop.mjs'), 'export function apply() {}\n')
    writeFileSync(join(profileDir, 'cordis.yml'), '- id: noop\n  name: ./noop.mjs\n')
    const sourceDir = tmp()
    writeFileSync(join(sourceDir, 'index.ts'), 'export const plugin = true\n')

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    await mountRootInclude(ctx, join(profileDir, 'cordis.yml'))
    await ctx.plugin(PluginInstallGateway, { enabled: true })
    const gateway = ctx.get('pluginInstall') as PluginInstallGateway

    const result = gateway.installPlugin({ form: 'file-dir', id: 'region-router', sourcePath: sourceDir })
    expect(result.profileDir).toBe(profileDir)
    expect(existsSync(join(profileDir, 'plugins', 'region-router', 'index.ts'))).toBe(true)
  })

  it('fails loud when neither an include entry nor a profileDir override exists', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    await ctx.plugin(PluginInstallGateway, { enabled: true })
    const gateway = ctx.get('pluginInstall') as PluginInstallGateway
    expect(installError(gateway, { form: 'file-dir', id: 'ok', sourcePath: tmp() })).toMatchObject({
      code: 'plugin-install/unknown-profile',
    })
  })
})
