/**
 * Mount→workspace synchronizer: makes every paired agent root appear as an
 * ordinary dsh workspace backed by its real shadow directory.
 *
 * dsh's workspace model requires a real, stat-able directory. This plugin
 * polls the hub's mount table and, for each of this instance's mounts,
 * ensures (a) the shadow directory exists on the server and (b) a workspace
 * registered for that shadow path. The region routers translate accesses
 * under the shadow tree back to the owning agent, so the workspace "is" the
 * remote root while dsh itself only sees a local directory.
 *
 * @module dsh-team-shell/mount-sync
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls ctx.workspaceRegistry + registry service merge.
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-workspace'
import { listMounts } from './client.ts'
import { ensureShadowDir } from './shadow.ts'
import type { MountRecord } from './hub.ts'

/** Plugin config supplied by the injected profile row. */
export interface MountSyncConfig {
  /** Hub control API base (loopback). */
  hubUrl: string
  /** Hub user id of this instance; only that user's mounts become workspaces. */
  user: string
  /** Root holding every mount's shadow directory (matches hub shadowRoot). */
  shadowRoot: string
  /** Resync interval in milliseconds (default 30_000). */
  intervalMs?: number
}

const DEFAULT_INTERVAL_MS = 30_000

/** Title shown in the workspace list for a mounted root. */
function mountTitle(agentId: string, root: string): string {
  const base = root.split(/[\\/]/).filter(Boolean).pop() ?? root
  return `↗ ${base} (${agentId})`
}

/** Ensure a mount's shadow dir exists and is registered as a workspace. */
async function syncMount(registry: WorkspaceRegistry, mount: MountRecord, user: string): Promise<void> {
  if (mount.user !== user) return
  await ensureShadowDir(mount.shadowPath)
  try {
    // create() realpaths + stats; an existing workspace for the same path
    // resolves via resolveByPath before we reach the create in the RPC layer.
    // Calling create twice with the same path is harmless here (registry keeps
    // one entity per canonical path); resolve-by-path short-circuits idempotency.
    const existing = registry.list().find((ws) => ws.path === mount.shadowPath)
    if (existing === undefined) {
      await registry.create(mount.shadowPath, mountTitle(mount.agentId, mount.root))
    } else if (existing.title !== mountTitle(mount.agentId, mount.root)) {
      await existing.setTitle(mountTitle(mount.agentId, mount.root))
    }
  } catch (error) {
    // A stale mount or a race with the UI: skip loudly.
    console.warn(`[mount-sync] could not register ${mount.shadowPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Sync every mount once (exported for tests). */
export async function syncAllMounts(
  hubUrl: string,
  user: string,
  registry: WorkspaceRegistry,
): Promise<number> {
  const mounts = await listMounts(hubUrl)
  let synced = 0
  for (const mount of mounts) {
    if (mount.user !== user) continue
    await syncMount(registry, mount, user)
    synced += 1
  }
  return synced
}

/**
 * Poll the hub and keep this instance's mounted roots registered as
 * workspaces. Returns a disposer that stops the poll.
 */
export function apply(ctx: Context, config: MountSyncConfig): () => void {
  const hubUrl = config.hubUrl.replace(/\/+$/, '')
  if (hubUrl === '') throw new Error('mount-sync: hubUrl is required')
  if (config.user === '') throw new Error('mount-sync: user is required')
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS

  const tick = (): void => {
    void syncAllMounts(hubUrl, config.user, ctx.workspaceRegistry).catch((error: unknown) => {
      console.warn(`[mount-sync] sync failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return () => { clearInterval(timer) }
}

/** Required services (loader resolves these before apply runs). */
export const inject = ['workspaceRegistry']
