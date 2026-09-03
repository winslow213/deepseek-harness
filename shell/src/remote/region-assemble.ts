/**
 * Region-router assembly: installs ONE ctx.fs (the region router) backed by
 * both the local sandboxed filesystem and every paired agent's mounted root.
 *
 * The shipped base bundle enables `fs-sandbox` as the host ctx.fs. This
 * plugin must therefore REPLACE that row (a profile patch disables
 * `fs-sandbox`), then re-load the local sandboxed filesystem into an isolated
 * fs realm so the region router (registered on the host realm) can delegate
 * local paths to it while serving mounted shadow-tree paths to remote agents.
 *
 * @module dsh-team-shell/region-assemble
 */

import type { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { RegionRouterFileSystem } from './region-router.ts'
import { DEFAULT_SHADOW_ROOT } from './shadow.ts'

/** Plugin config supplied by the injected profile row. */
export interface RegionAssembleConfig {
  /** Hub control API base the router forwards mounted operations to. */
  hubUrl: string
  /** Root holding every mount's shadow directory (default `/var/lib/dsh-mounts`). */
  shadowRoot?: string
  /** Local filesystem config forwarded to the sandboxed delegate. */
  localFs?: {
    cwd?: string
    diffBasisMaxBytes?: number
  }
}

/** Symbol label isolating the local fs realm from the router's host realm. */
const LOCAL_FS_REALM = Symbol('region.localFs')

/**
 * Load the local filesystem into its own isolated fs realm and register the
 * region router as the host ctx.fs. Returns a disposer that tears down the
 * local delegate fiber.
 */
export async function apply(ctx: Context, config: RegionAssembleConfig): Promise<() => Promise<void>> {
  const hubUrl = config.hubUrl.replace(/\/+$/, '')
  if (hubUrl === '') throw new Error('region-assemble: hubUrl is required')

  // 1. Local delegate in an isolated fs realm (its Service constructor
  //    registers under that realm, not the host realm the router claims).
  const localCtx = ctx.isolate('fs', LOCAL_FS_REALM)
  const localFiber = await localCtx.plugin(SandboxedFileSystem, {
    ...config.localFs ?? {},
  })

  // 2. The region router becomes the host ctx.fs. Read the isolated local
  //    delegate through reflect (bypasses the property proxy, which requires
  //    an inject declaration on this plugin's own context).
  const localFs = localCtx.reflect.get('fs', false) as import('@deepseek-ai/dsh-fs').FileSystem
  new RegionRouterFileSystem(ctx, {
    hubUrl,
    shadowRoot: config.shadowRoot ?? DEFAULT_SHADOW_ROOT,
  }, localFs)

  return async () => {
    await localFiber.dispose()
  }
}

export default { apply }
