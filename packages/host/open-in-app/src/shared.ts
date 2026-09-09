/**
 * Route paths and wire payloads shared verbatim by the host routes and the
 * browser package (`@deepseek-ai/dsh-client-ui-open-in-app`), published as
 * the `./shared` subpath. Browser-safe: constants and types only.
 */

/** GET route serving the probed application ids. */
export const OPEN_IN_APP_APPS_ROUTE = '/open-in-app/apps'

/** GET prefix serving one PNG bundle icon per application id. */
export const OPEN_IN_APP_ICON_PREFIX = '/open-in-app/icon'

/** POST route launching one application on one workspace directory. */
export const OPEN_IN_APP_OPEN_ROUTE = '/open-in-app/open'

/** Apps-route response: catalog ids probed as installed, in menu order. */
export interface OpenInAppAppsPayload {
  readonly apps: readonly string[]
  /**
   * true when the operator's browser is not on this host's desktop (an SSH
   * launch): GUI applications the host spawns cannot reach the operator's
   * screen, so the browser opens editor applications on the operator's own
   * machine through their URL scheme instead of the host launching them.
   */
  readonly clientLaunch: boolean
}

/** Open-route request body. */
export interface OpenInAppOpenPayload {
  readonly app: string
  readonly path: string
}
