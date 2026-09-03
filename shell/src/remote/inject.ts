/**
 * Inject the remote shell executor into a per-user dsh web profile.
 *
 * The executor imports `@deepseek-ai/dsh-shell`, which only resolves inside a
 * dsh runtime: the per-user instance's module closure (`$DSH_HOME/profiles/
 * node_modules`, healed at every boot) is the place its `@deepseek-ai/*`
 * imports become visible. The executor source therefore cannot live in this
 * `shell/` tree (outside the workspace, no ancestor node_modules carries the
 * packages) and is COPIED under the profile's plugins directory before the
 * profile patch row references it by absolute file URL.
 *
 * The patch layer (applied after every bundle layer) disables the shipped
 * local bash/pwsh sandbox rows and inserts `remote-shell`, leaving exactly
 * one `ctx.shell` provider. Delete the generated patch file to fall back to
 * the local executor.
 *
 * @module dsh-team-shell/remote-inject
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The user patch filename a profile dir holds (mirrors the boot constant). */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** Runtime modules copied into the profile plugins directory. */
export const REMOTE_RUNTIME_FILES = ['executor.ts', 'client.ts'] as const

/** Profile-relative plugin directory holding the copied remote executor runtime. */
export function pluginsDirFor(profileDir: string): string {
  return join(profileDir, 'plugins', 'remote')
}

/** Render the patch-layer YAML replacing local executors with the remote one. */
export function remoteShellPatchYaml(executorFileUrl: string, config: {
  hubUrl: string
  user: string
  cwd: string
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
}): string {
  const mode = config.sandboxMode ?? 'workspace-write'
  return [
    '# Injected by the team shell: route this instance\'s bash through the user\'s',
    '# remote agent. The shipped local executors are disabled so exactly one',
    '# ctx.shell provider remains (cordis rejects duplicate services).',
    '# The sandbox mode is the DECLARED intent for the agent root; the agent\'s',
    '# own command/path allowlists are the real fence.',
    '# Delete this file to fall back to the local executor.',
    '- id: bash-sandbox',
    '  disabled: true',
    '- id: pwsh-sandbox',
    '  disabled: true',
    '- insert:',
    '    - id: remote-shell',
    `      name: ${JSON.stringify(executorFileUrl)}`,
    '      config:',
    `        hubUrl: ${JSON.stringify(config.hubUrl)}`,
    `        user: ${JSON.stringify(config.user)}`,
    `        cwd: ${JSON.stringify(config.cwd)}`,
    `        sandboxMode: ${JSON.stringify(mode)}`,
    '',
  ].join('\n')
}

export interface InjectRemoteShellOptions {
  /** Directory of the executor runtime sources to copy (`shell/src/remote`). */
  runtimeSourceDir: string
  /** Hub control API base URL the executor relays to. */
  hubUrl: string
  /** Hub-registered user id whose agent serves the instance. */
  user: string
  /** Remote working directory the model's shell commands default to (under the agent `--root`). */
  cwd: string
  /** Profile directory to patch (`<DSH_HOME>/profiles/web`). */
  profileDir: string
  /** Declared sandbox intent for the agent root (default `workspace-write`). */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
}

/** Write (or refresh) the profile plugin copy and the patch row that selects the remote executor. */
export function injectRemoteShell(options: InjectRemoteShellOptions): string {
  const pluginsDir = pluginsDirFor(options.profileDir)
  mkdirSync(pluginsDir, { recursive: true })
  for (const file of REMOTE_RUNTIME_FILES) {
    cpSync(join(options.runtimeSourceDir, file), join(pluginsDir, file), { force: true })
  }
  const executorFileUrl = pathToFileURL(join(pluginsDir, 'executor.ts')).href
  const patch = join(options.profileDir, PROFILE_PATCH_FILENAME)
  writeFileSync(patch, remoteShellPatchYaml(executorFileUrl, {
    hubUrl: options.hubUrl,
    user: options.user,
    cwd: options.cwd,
    sandboxMode: options.sandboxMode,
  }))
  return patch
}

/** Remove the injected plugin copy and patch file (returns whether anything existed). */
export function removeRemoteShell(profileDir: string): boolean {
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
