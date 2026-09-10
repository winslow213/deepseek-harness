/**
 * Mounted-workspace declaration: tells the model, once per assembly, that its
 * working directory is a mounted shadow that mirrors a remote host rather than
 * a server-side path.
 *
 * Without this, the model searches the server's own workspace for the user's
 * code because nothing in the prompt says the cwd is remapped. This plugin
 * polls the hub mount table (the same source the routers consult) and registers
 * a prompt section whose text is derived from the session cwd and the current
 * mounts at assembly time — never from a hardcoded path, agent, or count, so a
 * user with zero, one, or many mounts gets an accurate declaration.
 *
 * @module dsh-team-shell/mount-declare
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls ctx.systemPrompt + PromptSectionOrderName merge.
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-system-prompt'
// Type-only: merges `agent` onto AssembleContext so the cwd is reachable.
import type {} from '@deepseek-ai/dsh-agent'
import { listMounts } from './client.ts'
import type { MountRecord } from './hub.ts'
import { renderMountedWorkspace } from './mount-declare-render.ts'

/** Plugin config supplied by the injected profile row. */
export interface MountDeclareConfig {
  /** Hub control API base (loopback). */
  hubUrl: string
  /** Hub user id of this instance; only that user's mounts are declared. */
  user: string
  /** Root holding every mount's shadow directory (matches hub shadowRoot). */
  shadowRoot: string
  /** Mount-table refresh interval in milliseconds (default 30_000). */
  intervalMs?: number
}

const DEFAULT_INTERVAL_MS = 30_000

/** Section name under which the declaration is registered. */
const SECTION_NAME = 'team-shell:mounted-workspace'

/**
 * Register the mounted-workspace prompt section and keep a fresh mount-table
 * cache for it. Returns a disposer that stops the poll and removes the section.
 */
export function apply(ctx: Context, config: MountDeclareConfig): () => void {
  const hubUrl = config.hubUrl.replace(/\/+$/, '')
  if (hubUrl === '') throw new Error('mount-declare: hubUrl is required')
  if (config.user === '') throw new Error('mount-declare: user is required')
  const shadowRoot = config.shadowRoot.replace(/\/+$/, '')
  if (shadowRoot === '') throw new Error('mount-declare: shadowRoot is required')
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS

  let mounts: readonly MountRecord[] = []
  let disposed = false
  const refresh = (): void => {
    void listMounts(hubUrl).then((next) => {
      if (!disposed) mounts = next
    }).catch(() => {
      // Keep the last known mounts; a transient hub blip must not blank the
      // declaration the model is about to read.
    })
  }
  refresh()
  const timer = setInterval(refresh, intervalMs)
  timer.unref?.()

  const dispose = ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: ctx.systemPrompt.getSectionOrder('MOUNTED_WORKSPACE'),
    text: (context: AssembleContext) => renderMountedWorkspace(context.agent?.session.header.cwd, mounts, config.user, shadowRoot),
  })

  return () => {
    disposed = true
    clearInterval(timer)
    dispose()
  }
}

/** Required services (loader resolves these before apply runs). */
export const inject = ['systemPrompt']
