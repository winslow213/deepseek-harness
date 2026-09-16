/**
 * Test-only sandbox seam for the search tools.
 *
 * The tools resolve the calling session's sandbox policy and wrap their
 * ripgrep argv through `ctx.sandbox`, so every test context needs both
 * services present. These fakes keep the wiring under test while making
 * confinement observable instead of real: {@link FakeSandbox} records each
 * `confine()` call and returns the argv unchanged, so a test can assert that
 * the policy reached the seam without depending on a host runner.
 *
 * @module dsh-tool-fs-search/tests/fake-sandbox
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjection from '@deepseek-ai/dsh-session-projection'

/** One `confine()` call, retained so a test can assert the resolved policy. */
export interface Confinement {
  argv: readonly string[]
  policy: SandboxPolicy
}

/**
 * A real `Session` carrying the given cwd, for the `exec.agent` the tools read.
 *
 * The sandbox policy service folds a session's logged `sandbox/mode` events to
 * resolve a mode, so a hand-rolled `{ header: { cwd } }` stand-in cannot stand
 * in: it has no log to fold. Building the real type keeps the fake faithful to
 * what the tools actually receive.
 *
 * @param cwd - the session workspace, or omitted for a session without one.
 * @returns the `agent` slice the search tools consume.
 */
export function sessionAgent(cwd?: string): { session: Session } {
  const id = SessionId(`search-test-${++sessionCounter}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, ...cwd === undefined ? {} : { cwd }, isSeeded: false,
  })
  return { session }
}

let sessionCounter = 0

/** A pass-through sandbox provider that records the policies it was handed. */
export class FakeSandbox extends Service {
  static inject = ['subprocess']

  /** Every `confine()` call in order. */
  readonly confinements: Confinement[] = []

  constructor(ctx: Context) {
    super(ctx, 'sandbox')
  }

  /** Record the call and hand back the caller's argv untouched (no real runner). */
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    this.confinements.push({ argv: [...argv], policy })
    return {
      argv: [...argv],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [],
    }
  }
}

/** Read the recording provider off a test context. */
export function fakeSandbox(ctx: Context): FakeSandbox {
  return ctx.get('sandbox', false) as FakeSandbox
}

/**
 * Mount the policy service and the recording sandbox provider on `ctx`.
 * @param ctx - the test context to mount onto.
 * @param config - optional sandbox-policy config (mode, workspaceRoot, read shield).
 */
export async function mountSandbox(
  ctx: Context,
  config: { mode?: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot?: string; readDeniedRoots?: string[]; readAllowedRoots?: string[] } = {},
): Promise<void> {
  // SandboxPolicyService registers a projection unit, so the registry must
  // exist before it loads.
  await ctx.plugin(SessionProjection)
  await ctx.plugin(SandboxPolicyService, {
    workspaceRoot: config.workspaceRoot ?? process.cwd(),
    ...config.mode === undefined ? {} : { mode: config.mode },
    ...config.readDeniedRoots === undefined ? {} : { readDeniedRoots: config.readDeniedRoots },
    ...config.readAllowedRoots === undefined ? {} : { readAllowedRoots: config.readAllowedRoots },
  })
  await ctx.plugin(FakeSandbox)
}
