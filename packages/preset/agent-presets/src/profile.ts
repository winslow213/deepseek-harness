/**
 * A preset-declared node profile: the reusable per-node persona and tool
 * scoping that a workflow `agent({ profile })` resolves. A preset directory
 * may carry an optional `profile.yml` beside its composition and its display
 * metadata; unlike the display text in `preset.yml`, a profile IS a capability
 * — it changes what a child is and may do — so a malformed one is reported at
 * discovery as a profile problem and refused at resolution, never silently
 * dropped.
 *
 * The file lives beside, not inside, `preset.yml` because that file is
 * documented as carrying display text ONLY, and authoring (a whole-directory
 * copy) must carry the profile along without the copy rewriting it.
 * @module @deepseek-ai/dsh-agent-presets/profile
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { load } from 'js-yaml'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools/types'

/** The optional file declaring a preset's node profile. */
export const PROFILE_FILE = 'profile.yml'

/** A preset's reusable per-node configuration, resolved by workflow `agent({ profile })`. */
export interface NodeProfile {
  /** Per-node persona text shadowing the deployment persona. */
  readonly persona?: string
  /** Per-node tool scoping. */
  readonly toolFilter?: ToolRestriction
}

/** A node profile that exists on disk but cannot be used. */
export class NodeProfileError extends Error {
  constructor(
    /** The preset id whose node profile is unusable. */
    readonly presetId: string,
    reason: string,
  ) {
    super(`agent-presets: node profile of preset "${presetId}" is unusable: ${reason}`)
    this.name = 'NodeProfileError'
  }
}

/** A non-empty trimmed string, or undefined for anything else. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Parse the `tools` entry of a profile: an `{ allow?, deny? }` object of tool-name arrays. */
function readToolFilter(raw: unknown): { value?: ToolRestriction; problem?: string } {
  if (raw === undefined) return {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { problem: '"tools" must be an object' }
  }
  const record = raw as Record<string, unknown>
  const names = (key: 'allow' | 'deny'): { value?: string[]; problem?: string } => {
    const value = record[key]
    if (value === undefined) return {}
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      return { problem: `"tools.${key}" must be an array of tool names` }
    }
    // Array.isArray narrows to any[]; the element check above proves strings.
    return { value: value as string[] }
  }
  const allow = names('allow')
  const deny = names('deny')
  if (allow.problem !== undefined) return { problem: allow.problem }
  if (deny.problem !== undefined) return { problem: deny.problem }
  if (allow.value === undefined && deny.value === undefined) {
    return { problem: '"tools" must name at least one tool in "allow" or "deny"' }
  }
  return {
    value: {
      ...allow.value !== undefined ? { allow: allow.value } : {},
      ...deny.value !== undefined ? { deny: deny.value } : {},
    },
  }
}

/**
 * Read one preset directory's node profile.
 *
 * An absent file is no profile — most presets are session roles with no
 * node-profile surface. A malformed or wrongly-shaped file is a profile
 * PROBLEM rather than an absent profile: dropping it would make a later
 * `agent({ profile })` fail with a misleading "declared none" instead of the
 * authoring error it actually is.
 * @param directory - the preset directory.
 * @returns the parsed profile, or the reason it cannot be used.
 */
export async function readNodeProfile(directory: string): Promise<{ profile?: NodeProfile; problem?: string }> {
  let raw: string
  try {
    raw = await readFile(join(directory, PROFILE_FILE), 'utf8')
  } catch {
    // Absent is the common case and any read failure means the same thing:
    // the directory presents no node profile.
    return {}
  }
  let parsed: unknown
  try {
    parsed = load(raw)
  } catch (error) {
    /* v8 ignore next -- js-yaml throws YAMLException (an Error) for every parse failure; the fallback keeps a hostile value readable */
    const full = error instanceof Error ? error.message : String(error)
    // First line only: js-yaml appends a multi-line code-frame snippet, and
    // the reason is surfaced on a resolution error, not in a terminal.
    return { problem: `the profile file ${PROFILE_FILE} is not valid YAML: ${full.replace(/\n[\s\S]*$/, '')}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { problem: `the profile file ${PROFILE_FILE} must be a map` }
  }
  const record = parsed as Record<string, unknown>
  const persona = text(record.persona)
  const tools = readToolFilter(record.tools)
  if (tools.problem !== undefined) {
    return { problem: `the profile file ${PROFILE_FILE} has an invalid "tools" entry: ${tools.problem}` }
  }
  if (persona === undefined && tools.value === undefined) {
    return { problem: `the profile file ${PROFILE_FILE} must declare a "persona" or a "tools" entry` }
  }
  return {
    profile: {
      ...persona !== undefined ? { persona } : {},
      ...tools.value !== undefined ? { toolFilter: tools.value } : {},
    },
  }
}
