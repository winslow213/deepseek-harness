import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { bwrapProfileArgs } from '../src/profiles.ts'

/**
 * Keyless backend integration through `confine()` and a real bwrap process. With no rung forced,
 * a passing probe must select the first rung. Tests assert world effects, wrap shape, and that the
 * kernel denial matches the advertised dialect; consumer coverage lives in dsh-bash-sandbox.
 * Skips when bwrap or user namespaces are unavailable. HOME-based workspaces avoid bwrap's
 * ephemeral `/tmp`, so workspace-write actually proves the workspace-root rebind.
 */

const probe = spawnSync('bwrap', [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'], { timeout: 5_000, stdio: 'ignore' })
const bwrapUsable = probe.status === 0

let ctx: Context | undefined
const tempDirs: string[] = []
const tempFiles: string[] = []

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  for (const file of tempFiles.splice(0)) rmSync(file, { force: true })
})

async function tempDir(base: string): Promise<string> {
  const dir = await mkdtemp(join(base, 'dsh-bwrap-e2e-'))
  tempDirs.push(dir)
  return dir
}

async function provider(): Promise<LocalSandboxProvider> {
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {})
  return ctx.sandbox as LocalSandboxProvider
}

/** Confine a shell command under `policy` and run it for real; returns the spawn result and the wrap's facts. */
function runConfined(sandbox: LocalSandboxProvider, command: string, policy: SandboxPolicy) {
  const confined = sandbox.confine(['bash', '-c', command], policy)
  const result = spawnSync(confined.argv[0] as string, confined.argv.slice(1), { timeout: 30_000, encoding: 'utf8' })
  return { result, confined }
}

describe.skipIf(!bwrapUsable)('sandbox-local: real bwrap confinement', () => {
  it('the passing probe selects the bwrap rung naturally — first in the ladder, full enforcement, EROFS dialect', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const confined = sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: workdir })
    expect(confined.argv[0]).toBe('bwrap')
    expect(confined.enforcement).toBe('full')
    expect(confined.denialSignatures).toEqual(['read-only file system'])
  })

  it('read-only denies a write — the file must NOT exist, and the kernel speaks the advertised dialect', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result } = runConfined(sandbox, `echo hi > ${workdir}/denied.txt`, { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).not.toBe(0)
    // The wrap's denialSignatures must be what the kernel actually prints.
    expect(result.stderr.toLowerCase()).toContain('read-only file system')
    expect(existsSync(join(workdir, 'denied.txt'))).toBe(false)
  })

  it('read-only keeps the tree readable/executable and the fresh /dev/null writable', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result } = runConfined(sandbox, 'ls / > /dev/null && echo dev-ok', { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('dev-ok\n')
  })

  it.each(['read-only', 'workspace-write'] as const)(
    '%s runs in a private PID namespace and blocks writes through procfs root magic links',
    async (mode) => {
      const workdir = await tempDir(homedir())
      const outside = await tempDir(homedir())
      const target = join(outside, 'escaped.txt')
      const sandbox = await provider()
      // Compare PID-namespace identity, not PID numbers: numeric /proc entries
      // recur inside a private namespace, and the /proc/1/root write below is
      // denied even in a shared namespace (host init is root-owned), so this
      // comparison is the assertion that fails when --unshare-pid is lost.
      const hostPidNamespace = readlinkSync('/proc/self/ns/pid')
      const visibility = runConfined(sandbox, 'readlink /proc/self/ns/pid', { mode, workspaceRoot: workdir })
      expect(visibility.result.status).toBe(0)
      expect(visibility.result.stdout.trim()).not.toBe('')
      expect(visibility.result.stdout.trim()).not.toBe(hostPidNamespace)

      const escape = runConfined(
        sandbox,
        `printf escaped > /proc/1/root${target}`,
        { mode, workspaceRoot: workdir },
      )
      expect(escape.result.status).not.toBe(0)
      expect(existsSync(target)).toBe(false)
    },
  )

  it('keeps descendants observable and controllable inside the private PID namespace', async () => {
    const workdir = await tempDir(homedir())
    const sandbox = await provider()
    const { result } = runConfined(
      sandbox,
      'sleep 30 & child=$!; kill -0 "$child" && kill "$child"; wait "$child"; status=$?; test "$status" -ge 128',
      { mode: 'read-only', workspaceRoot: workdir },
    )
    expect(result.status).toBe(0)
  })

  it('workspace-write lands a write inside the workspace root and still denies one beside it', async () => {
    const workdir = await tempDir(homedir())
    const outside = await tempDir(homedir())
    const sandbox = await provider()

    const inside = runConfined(sandbox, `printf bwrap-ok > ${workdir}/allowed.txt`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(inside.result.status).toBe(0)
    expect(readFileSync(join(workdir, 'allowed.txt'), 'utf8')).toBe('bwrap-ok')

    const denied = runConfined(sandbox, `echo hi > ${outside}/denied.txt`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(denied.result.status).not.toBe(0)
    expect(existsSync(join(outside, 'denied.txt'))).toBe(false)
  })

  it('workspace-write mounts an EPHEMERAL /tmp: the write succeeds inside, the host /tmp stays untouched', async () => {
    // The documented bwrap-profile difference: Landlock and Seatbelt grant
    // the HOST temp areas, bwrap swaps in a fresh tmpfs that dies with the
    // process — the strongest of the three temp semantics.
    const workdir = await tempDir(homedir())
    const target = `/tmp/dsh-bwrap-e2e-ephemeral-${process.pid}.txt`
    tempFiles.push(target)
    const sandbox = await provider()
    const { result } = runConfined(sandbox, `printf tmp-ok > ${target} && cat ${target}`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('tmp-ok')
    expect(existsSync(target)).toBe(false)
  })
})

/**
 * The read shield is the one sandbox property that write confinement cannot
 * express: a mode bounds what a command may MODIFY, never what it may READ, so
 * every readable file on the host stays readable until a policy names a denied
 * root. These cases run the real mounts because the masking depends on bwrap's
 * argument-order semantics, which no profile-string assertion can prove.
 */
describe.skipIf(!bwrapUsable)('sandbox-local: read shielding between sibling tenants', () => {
  /** A shared users root holding the caller's home and one sibling's home, each with a secret. */
  async function tenants(): Promise<{ root: string; own: string; sibling: string }> {
    // Under HOME, not tmpdir(): workspace-write mounts an ephemeral `/tmp`, so
    // a tenants root placed there would be shadowed before any shield applied.
    const root = await tempDir(homedir())
    const own = join(root, 'caller')
    const sibling = join(root, 'sibling')
    await mkdir(own, { recursive: true })
    await mkdir(sibling, { recursive: true })
    await writeFile(join(own, 'own-secret.txt'), 'own')
    await writeFile(join(sibling, 'credentials.yaml'), 'sk-sibling')
    return { root, own, sibling }
  }

  function shieldPolicy(workdir: string, root: string, own: string): SandboxPolicy {
    return {
      mode: 'workspace-write',
      workspaceRoot: workdir,
      readDeniedRoots: [root],
      readAllowedRoots: [own],
    }
  }

  it('hides a sibling tenant entirely — its directory does not even appear', async () => {
    const { root, own, sibling } = await tenants()
    const workdir = await tempDir(homedir())
    const sandbox = await provider()

    const { result } = runConfined(sandbox, `ls ${root}`, shieldPolicy(workdir, root, own))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('caller')
    expect(result.stdout).not.toContain('sibling')
    expect(existsSync(sibling)).toBe(true)
  })

  it('denies a read of the sibling tenant file, and the same read succeeds without the shield', async () => {
    const { root, own, sibling } = await tenants()
    const workdir = await tempDir(homedir())
    const sandbox = await provider()

    const unshielded = runConfined(sandbox, `cat ${sibling}/credentials.yaml`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(unshielded.result.stdout).toBe('sk-sibling')

    const shielded = runConfined(sandbox, `cat ${sibling}/credentials.yaml`, shieldPolicy(workdir, root, own))
    expect(shielded.result.status).not.toBe(0)
    expect(shielded.result.stdout).not.toContain('sk-sibling')
  })

  it('keeps the caller tenant readable and its workspace writable through the same shield', async () => {
    const { root, own } = await tenants()
    const workdir = await tempDir(homedir())
    const sandbox = await provider()

    const { result } = runConfined(
      sandbox,
      `cat ${own}/own-secret.txt && printf wrote > ${workdir}/out.txt`,
      shieldPolicy(workdir, root, own),
    )
    expect(result.stdout).toContain('own')
    expect(result.status).toBe(0)
    expect(readFileSync(join(workdir, 'out.txt'), 'utf8')).toBe('wrote')
  })

  it('leaves the system toolchain usable, so the mask hides tenants without breaking the shell', async () => {
    const { root, own } = await tenants()
    const workdir = await tempDir(homedir())
    const sandbox = await provider()

    const { result } = runConfined(
      sandbox,
      'command -v bash && command -v node && bash -c "echo shell-ok"',
      shieldPolicy(workdir, root, own),
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('shell-ok')
  })
})
