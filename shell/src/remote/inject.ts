/**
 * Inject the remote shell executor and filesystem provider into a per-user dsh
 * web profile.
 *
 * The providers import `@deepseek-ai/*` packages, which only resolve inside a
 * dsh runtime: the per-user instance's module closure (`$DSH_HOME/profiles/
 * node_modules`, healed at every boot) is where those imports become visible.
 * Their source therefore cannot live in this `shell/` tree (outside the
 * workspace) and is COPIED under the profile's plugins directory before the
 * profile patch row references it by absolute file URL.
 *
 * The patch layer (applied after every bundle layer) disables the shipped
 * local bash/pwsh/fs sandbox rows and inserts `remote-shell` (and optionally
 * `remote-fs`), leaving exactly one `ctx.shell` and one `ctx.fs` provider.
 * Delete the generated patch file to fall back to the local providers.
 *
 * @module dsh-team-shell/remote-inject
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The user patch filename a profile dir holds (mirrors the boot constant). */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** Runtime modules copied into the profile plugins directory. */
export const REMOTE_RUNTIME_FILES = ['executor.ts', 'fs-provider.ts', 'client.ts'] as const

/** Profile plugin directory holding the copied remote provider runtime. */
export function pluginsDirFor(profileDir: string): string {
  return join(profileDir, 'plugins', 'remote')
}

/** Declared sandbox intent for the agent root (permission stack composition). */
export type RemoteSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Render the patch-layer YAML replacing local providers with the remote ones. */
export function remoteProvidersPatchYaml(config: {
  hubUrl: string
  user: string
  shellCwd: string
  fsCwd: string
  executorFileUrl: string
  fsProviderFileUrl: string
  includeFs: boolean
  sandboxMode?: RemoteSandboxMode
}): string {
  const mode = config.sandboxMode ?? 'workspace-write'
  const lines = [
    '# Injected by the team shell: route this instance\'s bash and filesystem through',
    '# the user\'s remote agent. The shipped local sandbox providers are disabled so',
    '# exactly one ctx.shell and one ctx.fs provider remain (cordis rejects duplicates).',
    '# The sandbox mode is the DECLARED intent for the agent root; the agent\'s own',
    '# command/path allowlists are the real fence.',
    '# Delete this file to fall back to the local providers.',
    '- id: bash-sandbox',
    '  disabled: true',
    '- id: pwsh-sandbox',
    '  disabled: true',
    '- insert:',
    '    - id: remote-shell',
    `      name: ${JSON.stringify(config.executorFileUrl)}`,
    '      config:',
    `        hubUrl: ${JSON.stringify(config.hubUrl)}`,
    `        user: ${JSON.stringify(config.user)}`,
    `        cwd: ${JSON.stringify(config.shellCwd)}`,
    `        sandboxMode: ${JSON.stringify(mode)}`,
  ]
  if (config.includeFs) {
    lines.push(
      '',
      '- id: fs-sandbox',
      '  disabled: true',
      '- insert:',
      '    - id: remote-fs',
      `      name: ${JSON.stringify(config.fsProviderFileUrl)}`,
      '      config:',
      `        hubUrl: ${JSON.stringify(config.hubUrl)}`,
      `        user: ${JSON.stringify(config.user)}`,
      `        cwd: ${JSON.stringify(config.fsCwd)}`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

export interface InjectRemoteProvidersOptions {
  /** Directory of the provider runtime sources to copy (`shell/src/remote`). */
  runtimeSourceDir: string
  /** Hub control API base URL the providers relay to. */
  hubUrl: string
  /** Hub-registered user id whose agent serves the instance. */
  user: string
  /** Remote working directory the model's shell commands default to (under the agent `--root`). */
  shellCwd: string
  /** Remote working directory the filesystem resolves relative paths against (under the agent `--root`). */
  fsCwd: string
  /** Profile directory to patch (`<DSH_HOME>/profiles/web`). */
  profileDir: string
  /** Also inject the remote filesystem provider (default true). */
  includeFs?: boolean
  /** Declared sandbox intent for the agent root (default `workspace-write`). */
  sandboxMode?: RemoteSandboxMode
}

/** Write (or refresh) the profile plugin copy and the patch rows selecting the remote providers. */
export function injectRemoteProviders(options: InjectRemoteProvidersOptions): string {
  const pluginsDir = pluginsDirFor(options.profileDir)
  mkdirSync(pluginsDir, { recursive: true })
  for (const file of REMOTE_RUNTIME_FILES) {
    cpSync(join(options.runtimeSourceDir, file), join(pluginsDir, file), { force: true })
  }
  const executorFileUrl = pathToFileURL(join(pluginsDir, 'executor.ts')).href
  const fsProviderFileUrl = pathToFileURL(join(pluginsDir, 'fs-provider.ts')).href
  const patch = join(options.profileDir, PROFILE_PATCH_FILENAME)
  writeFileSync(patch, remoteProvidersPatchYaml({
    hubUrl: options.hubUrl,
    user: options.user,
    shellCwd: options.shellCwd,
    fsCwd: options.fsCwd,
    executorFileUrl,
    fsProviderFileUrl,
    includeFs: options.includeFs ?? true,
    sandboxMode: options.sandboxMode,
  }))
  return patch
}

/** Back-compat alias: inject only the remote shell provider (no fs). */
export function injectRemoteShell(options: {
  runtimeSourceDir: string
  hubUrl: string
  user: string
  cwd: string
  profileDir: string
  sandboxMode?: RemoteSandboxMode
}): string {
  return injectRemoteProviders({
    runtimeSourceDir: options.runtimeSourceDir,
    hubUrl: options.hubUrl,
    user: options.user,
    shellCwd: options.cwd,
    fsCwd: options.cwd,
    profileDir: options.profileDir,
    includeFs: false,
    sandboxMode: options.sandboxMode,
  })
}

/** Remove the injected plugin copy and patch file (returns whether anything existed). */
export function removeRemoteProviders(profileDir: string): boolean {
  let removed = false
  const pluginsDir = pluginsDirFor(profileDir)
  if (existsSync(pluginsDir)) {
    rmSync(pluginsDir, { recursive: true, force: true })
    removed = true
  }
  const patch = join(profileDir, PROFILE_PATCH_FILENAME)
  if (existsSync(patch)) {
    // Only remove when it is our generated patch (the header marks it).
    try {
      const text = readFileSync(patch, 'utf8')
      if (text.includes('Injected by the team shell')) {
        rmSync(patch, { force: true })
        removed = true
      }
    } catch {
      // Unreadable patch: leave it for the operator.
    }
  }
  return removed
}

/** Back-compat alias for {@link removeRemoteProviders}. */
export function removeRemoteShell(profileDir: string): boolean {
  return removeRemoteProviders(profileDir)
}
