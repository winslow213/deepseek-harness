/** Browser availability/choice state and the launch carrier for the split button. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  OPEN_IN_APP_APPS_ROUTE, OPEN_IN_APP_OPEN_ROUTE,
  type OpenInAppAppsPayload, type OpenInAppOpenPayload,
} from '@deepseek-ai/dsh-host-open-in-app/shared'

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>

/** Hand a URL to the browser; assigning an external scheme triggers its OS protocol handler. */
type Navigate = (url: string) => void

/**
 * Editor catalog ids and their URL schemes. When the host reports a remote
 * (SSH) launch, these applications open on the operator's machine through
 * their scheme instead of the host spawning them; applications absent here
 * keep the host launch.
 */
const DEEP_LINK_URI: Readonly<Record<string, string>> = {
  vscode: 'vscode://',
  vscodeinsiders: 'vscode-insiders://',
  cursor: 'cursor://',
  windsurf: 'windsurf://',
  zed: 'zed://',
}

/** Resolve the browser's Host base with the connection carrier's null-origin fallback. */
function hostBase(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
}

/**
 * Owns the once-per-page availability read, the persisted last choice, and
 * the launch POST. Availability and choice publish through uSES-safe sources
 * so every Session header shares one truth.
 */
export class OpenInAppController {
  /** Installed app ids in host menu order; null until the host answered. */
  readonly apps: SnapshotStore<readonly string[] | null> = createSnapshotStore<readonly string[] | null>(null)
  /** Last chosen app id, or empty before the first choice, shared across sessions and browser restarts. */
  readonly choice: SnapshotStore<string> = createSnapshotStore<string>('', {
    persist: { name: 'dsh.open-in-app.choice' },
  })

  private loading: Promise<void> | undefined
  /** Host-reported remote launch: editors open client-side through their URL scheme. */
  private clientLaunch = false

  /**
   * @param fetcher - HTTP carrier for the apps read and the launch POST.
   * @param navigate - deep-link carrier for client-side editor launches.
   */
  constructor(
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
    private readonly navigate: Navigate = (url) => {
      const location = (globalThis as { location?: { href?: string } }).location
      if (location !== undefined) location.href = url
    },
  ) {}

  /**
   * Read availability once per controller life; concurrent calls share the read.
   * A failed read publishes an empty list, which renders no button at all.
   * @returns after availability is published.
   */
  load(): Promise<void> {
    this.loading ??= this.run()
    return this.loading
  }

  /**
   * Remember one picked app id.
   * @param appId - catalog id from the availability list.
   */
  choose(appId: string): void {
    this.choice.set(appId)
  }

  /**
   * Launch one installed app on a workspace directory.
   * @param appId - catalog id from the availability list.
   * @param path - the session's absolute workspace directory.
   * @returns after the host acknowledged the launch; rejects on any failure.
   */
  async launch(appId: string, path: string): Promise<void> {
    if (this.clientLaunch) {
      const uri = DEEP_LINK_URI[appId]
      if (uri !== undefined) {
        this.navigate(uri)
        return
      }
    }
    const body: OpenInAppOpenPayload = { app: appId, path }
    const response = await this.fetcher(new URL(OPEN_IN_APP_OPEN_ROUTE, hostBase()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`open failed: HTTP ${String(response.status)}`)
  }

  private async run(): Promise<void> {
    let apps: readonly string[] = []
    try {
      const response = await this.fetcher(new URL(OPEN_IN_APP_APPS_ROUTE, hostBase()), {
        headers: { accept: 'application/json' },
      })
      if (response.ok) {
        const payload = await response.json() as OpenInAppAppsPayload
        if (Array.isArray(payload.apps)) apps = payload.apps.filter(id => typeof id === 'string')
        this.clientLaunch = payload.clientLaunch
      }
    } catch {
      // Swallows network failures: an unreachable host reads as no apps, and
      // the header simply shows no button rather than a broken one.
    }
    this.apps.set(apps)
  }
}
