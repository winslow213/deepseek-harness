/**
 * Client for the team account service's instance-registration endpoints.
 *
 * A per-user spawn (or its supervisor) registers the loopback port of the
 * running dsh web instance so the account-mode proxy can route an
 * authenticated member to it. Registration and removal are operator-side
 * actions protected by the account service's shared admin secret.
 *
 * @module dsh-team-shell/instance-register
 */

/** Account service base URL from env; absent when no team account layer is deployed. */
export function accountBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = env.TEAM_ACCOUNT_URL
  return url === undefined || url === '' ? undefined : url
}

/** The shared secret operator-side services present on registration calls. */
export function adminSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const secret = env.TEAM_ADMIN_SECRET
  return secret === undefined || secret === '' ? undefined : secret
}

/** Extract the launch token from a dsh authenticated URL (`.../?token=...`). */
export function launchTokenFromUrl(url: string): string | undefined {
  try {
    const token = new URL(url).searchParams.get('token')
    return token === null ? undefined : token
  } catch {
    return undefined
  }
}

/** Register (or refresh) one user's spawned instance port with the account service. */
export async function registerInstance(
  accountUrl: string,
  userId: string,
  port: number,
  opts: { pid?: number; launchToken?: string; secret?: string } = {},
): Promise<boolean> {
  try {
    const res = await fetch(`${accountUrl.replace(/\/+$/, '')}/api/instances`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...opts.secret === undefined ? {} : { 'x-team-admin-secret': opts.secret },
      },
      body: JSON.stringify({
        user_id: userId,
        port,
        ...opts.pid === undefined ? {} : { pid: opts.pid },
        ...opts.launchToken === undefined ? {} : { launch_token: opts.launchToken },
      }),
    })
    return res.ok
  } catch (error) {
    console.error(`[instance-register] register failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/** Remove one user's spawned-instance registration. */
export async function unregisterInstance(
  accountUrl: string,
  userId: string,
  secret?: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${accountUrl.replace(/\/+$/, '')}/api/instances/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: secret === undefined ? {} : { 'x-team-admin-secret': secret },
    })
    return res.ok
  } catch (error) {
    console.error(`[instance-register] unregister failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
