/**
 * Self-restart protocol for a profile change that cannot apply live. A
 * startup-only profile (`patchReload: 'startup'`) has no `hmr` service, so
 * `PluginManager.change()` reports `restart-required` and the change waits for
 * the next launch. Under a supervisor that relaunches on request, this module
 * is what turns that report into the relaunch: write the marker the supervisor
 * watches, then exit so it starts a fresh instance carrying the new plugin.
 * @module @deepseek-ai/dsh-plugin-manager/supervised-restart
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Environment variable a supervisor sets so the instance knows it may restart.
 * A bare `dsh` run has no supervisor to relaunch it and killing the process
 * would strand the terminal, so the protocol stays dormant without this.
 */
export const DSH_SUPERVISED_ENV = 'DSH_SUPERVISED'

/**
 * The restart-marker filename a supervised instance writes before exiting, so
 * its supervisor relaunches it in place. The name is a shared literal protocol
 * with shell/src/spawn-user.ts; that tree is standalone and cannot import from
 * packages, so both sides carry the name.
 */
export const RESTART_MARKER = '.dsh-restart-requested'

/** How long to wait before exiting, so the Remote response reaches the browser before the socket closes. */
const RESTART_GRACE_MS = 800

/**
 * Request a supervised restart for a profile whose change cannot apply live.
 * Writes the marker the supervisor watches, then self-terminates after
 * {@link RESTART_GRACE_MS} so callers finish replying. SIGTERM is the
 * supervisor's ordinary stop request; the marker written here is what makes it
 * relaunch rather than shut the account down.
 * @param profileDir The profile directory whose marker file the supervisor watches.
 * @returns whether a restart was requested, false when no supervisor contract is in effect.
 */
export function requestRestartIfSupervised(profileDir: string): boolean {
  if (process.env[DSH_SUPERVISED_ENV] !== '1') return false
  writeFileSync(join(profileDir, RESTART_MARKER), `${new Date().toISOString()}\n`)
  console.warn(`[plugin-manager] change requires a restart; exiting so the supervisor relaunches in ${RESTART_GRACE_MS}ms`)
  setTimeout(() => {
    process.kill(process.pid, 'SIGTERM')
  }, RESTART_GRACE_MS).unref()
  return true
}
