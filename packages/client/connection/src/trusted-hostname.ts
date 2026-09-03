/**
 * Browser-safe trusted-authority classification shared by the page-side
 * privileged-surface check. Mirrors the Host-side `isTrustedAuthority`
 * semantics (see `api-request-trust.ts`): a port-less entry matches the
 * hostname on any port; an entry with an explicit port matches that exact
 * authority. This module is the browser twin — it takes a URL instead of raw
 * request headers so the page can classify its own `location`.
 */

/** Global key the Host injects the deployment `trustedHosts` under. */
export const TRUSTED_HOSTS_GLOBAL = '__DSH_TRUSTED_HOSTS__' as const

/**
 * Whether a normalized page URL's authority matches a `trustedHosts` entry.
 * @param pageUrl - the page authority (WHATWG URL; hostname lowercased).
 * @param trustedHosts - deployment authorities; port-less entries match any port.
 * @returns true when the page's hostname (or exact host:port) is listed.
 */
export function isTrustedPageAuthority(
  pageUrl: URL,
  trustedHosts: readonly string[],
): boolean {
  return trustedHosts.some((entry) => {
    let entryUrl: URL
    try {
      entryUrl = new URL(`http://${entry}`)
    } catch {
      // A malformed entry is a host-side config error and simply never
      // matches here; the Host-side fence already rejected it at load.
      return false
    }
    const entryPort = entryUrl.port
    // A port-less entry names the hostname on any port; an entry with an
    // explicit port names the exact authority.
    if (entryPort === '') return entryUrl.hostname === pageUrl.hostname
    return entryUrl.host === pageUrl.host
  })
}
