/**
 * Per-user personal wiki: file layout, skeleton scaffolding, and the append/
 * replace semantics shared by account provisioning (`spawn-user.ts`, which
 * scaffolds before the instance starts) and the `wiki_note` tool (which
 * writes at runtime, copied into the profile by
 * {@link file://./wiki-tool.ts}). Pure Node fs — no `@deepseek-ai/*` imports —
 * so this module type-checks under the plain `shell/tsconfig.json` and can be
 * imported from both the provisioning side and the copied runtime plugin.
 *
 * Four layers, four files:
 * - `identity` (L1) and `preferences` (L2) sit directly in the workspace root
 *   so `@deepseek-ai/dsh-agent-instructions`'s `localInstructionFileCandidates`
 *   picks them up every turn (that walk only checks the project-root..cwd
 *   ancestor chain, never subdirectories) — always fully loaded, overwritten
 *   whole on each `wiki_note` call, never appended.
 * - `timeline` (L3) and `decisions` (L4) sit under a hidden `.dsh/wiki/`
 *   subdirectory: append-only logs, read on demand with the ordinary file
 *   tool rather than auto-loaded into every turn's baseline context.
 *
 * @module dsh-team-shell/wiki-fs
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** L1 identity file: stable facts about the person, overwritten whole. */
export const WIKI_IDENTITY_FILE = '.dsh-wiki-identity.md'

/** L2 preferences file: working patterns/preferences, overwritten whole. */
export const WIKI_PREFERENCES_FILE = '.dsh-wiki-preferences.md'

/** Subdirectory (relative to the workspace root) holding the append-only layers. */
export const WIKI_LOG_SUBDIR = join('.dsh', 'wiki')

/** L3 timeline file: append-only dated log of notable progress/breakthroughs. */
export const WIKI_TIMELINE_FILE = join(WIKI_LOG_SUBDIR, 'timeline.md')

/** L4 decisions file: append-only, never-edited record of decisions and rejected alternatives. */
export const WIKI_DECISIONS_FILE = join(WIKI_LOG_SUBDIR, 'decisions.md')

/** The four wiki layer kinds a `wiki_note` call may target. */
export type WikiLayer = 'identity' | 'preferences' | 'timeline' | 'decision'

const IDENTITY_SKELETON = [
  '# 身份与背景（L1 · Identity）',
  '',
  '本文件由 dsh 通过 `wiki_note` 工具整体覆写维护，记录关于你的稳定事实：',
  '姓名/称呼、角色、所在团队、长期目标等。每次调用都会用最新内容整体替换本文件。',
  '',
].join('\n')

const PREFERENCES_SKELETON = [
  '# 技术偏好与工作模式（L2 · Preferences）',
  '',
  '本文件由 dsh 通过 `wiki_note` 工具整体覆写维护，记录相对稳定但会演化的偏好：',
  '常用工具/语言、代码风格、沟通习惯、审阅偏好等。每次调用都会用最新内容整体替换本文件。',
  '',
].join('\n')

const TIMELINE_SKELETON = [
  '# 时间线（L3 · Timeline）',
  '',
  '追加式记录：每一次对话中的重要进展或突破，按时间顺序追加，从不修改或删除历史条目。',
  '',
].join('\n')

const DECISIONS_SKELETON = [
  '# 决策记录（L4 · Decisions）',
  '',
  '追加式记录：推理过程中人与模型做出的关键决策、考虑过并放弃的方案、决策方。',
  '从不修改或删除历史条目；推翻一个决策时，追加一条新记录并在其中标注被推翻的条目已作废。',
  '',
].join('\n')

/** Absolute paths of the four wiki layer files under one workspace root. */
export interface WikiPaths {
  identity: string
  preferences: string
  timeline: string
  decisions: string
}

/** Resolve the four wiki layer file paths for a workspace root. */
export function wikiPaths(workspaceRoot: string): WikiPaths {
  return {
    identity: join(workspaceRoot, WIKI_IDENTITY_FILE),
    preferences: join(workspaceRoot, WIKI_PREFERENCES_FILE),
    timeline: join(workspaceRoot, WIKI_TIMELINE_FILE),
    decisions: join(workspaceRoot, WIKI_DECISIONS_FILE),
  }
}

/** A whole-replace wiki layer kind (identity/preferences), as opposed to the append-only pair. */
export type WholeReplaceWikiLayer = 'identity' | 'preferences'

/**
 * Read the current on-disk content of a whole-replace layer (identity or
 * preferences), or `''` if the file does not exist yet. Used both to render
 * the layer and as the baseline for {@link writeWikiLayer}'s conflict check.
 * @param workspaceRoot - the account's private workspace root.
 * @param layer - `identity` or `preferences`.
 */
export function readWikiLayer(workspaceRoot: string, layer: WholeReplaceWikiLayer): string {
  const path = wikiPaths(workspaceRoot)[layer]
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/**
 * Create the four wiki layer files with their skeleton content when absent.
 * Idempotent: an existing file (including one the model has already written
 * to) is never touched. Called at account provisioning time, before the
 * instance starts, so the wiki always exists by the user's first turn.
 * @param workspaceRoot - the account's private workspace root.
 */
export function scaffoldUserWiki(workspaceRoot: string): void {
  const paths = wikiPaths(workspaceRoot)
  mkdirSync(join(workspaceRoot, WIKI_LOG_SUBDIR), { recursive: true })
  const skeletons: [string, string][] = [
    [paths.identity, IDENTITY_SKELETON],
    [paths.preferences, PREFERENCES_SKELETON],
    [paths.timeline, TIMELINE_SKELETON],
    [paths.decisions, DECISIONS_SKELETON],
  ]
  for (const [path, skeleton] of skeletons) {
    if (!existsSync(path)) writeFileSync(path, skeleton)
  }
}

/** One dated timeline/decision entry rendered by {@link renderLogEntry}. */
export interface WikiLogEntry {
  title: string
  content: string
  /** Decision-kind only: alternatives considered and why they were rejected. */
  alternativesConsidered?: string
  /** Decision-kind only: who made the call. */
  decidedBy?: 'user' | 'model' | 'joint'
}

/** Render one append-only dated entry (shared heading/body layout for both L3 and L4). */
function renderLogEntry(entry: WikiLogEntry): string {
  const lines = [`## ${new Date().toISOString()} — ${entry.title}`, '', entry.content.trim()]
  if (entry.decidedBy !== undefined) lines.push('', `**决策方**：${entry.decidedBy}`)
  if (entry.alternativesConsidered !== undefined && entry.alternativesConsidered.trim() !== '') {
    lines.push('', `**考虑过并放弃的方案**：${entry.alternativesConsidered.trim()}`)
  }
  lines.push('', '')
  return lines.join('\n')
}

/**
 * Thrown by {@link writeWikiLayer} when a `baseline` was supplied for a
 * whole-replace layer (identity/preferences) and the file's current on-disk
 * content no longer matches it — evidence another session wrote to the same
 * file since this caller last read it. The write is refused; nothing is
 * overwritten. {@link currentContent} carries the latest on-disk content so
 * the caller can merge into it before retrying.
 */
export class WikiWriteConflictError extends Error {
  /** The layer whose write was refused. */
  readonly layer: WholeReplaceWikiLayer
  /** The file's actual current content at the time of the refused write. */
  readonly currentContent: string

  constructor(layer: WholeReplaceWikiLayer, currentContent: string) {
    super(`wiki ${layer} file changed on disk since the caller's baseline was read`)
    this.name = 'WikiWriteConflictError'
    this.layer = layer
    this.currentContent = currentContent
  }
}

/**
 * Apply one `wiki_note` write: `identity`/`preferences` replace the whole
 * layer file (mirroring `todo_write`'s whole-list replace); `timeline`/
 * `decision` append a new dated entry and never rewrite an earlier one.
 * @param workspaceRoot - the account's private workspace root.
 * @param layer - which of the four layers this call targets.
 * @param entry - the content to write; `title` is required for the two
 *   append-only layers and ignored for `identity`/`preferences`.
 * @param baseline - identity/preferences only: the content the caller last
 *   read for this layer. When supplied, the write is refused with a
 *   {@link WikiWriteConflictError} if the file's current content no longer
 *   matches it — closing the whole-replace layers' data-loss window where a
 *   second concurrent session (for example a shadow-pairing mount and the
 *   user's main session sharing one backing workspace) silently clobbers the
 *   first session's write. Omit it to keep the previous unconditional
 *   overwrite (provisioning and tests that do not need the check).
 */
export function writeWikiLayer(
  workspaceRoot: string,
  layer: WikiLayer,
  entry: WikiLogEntry,
  baseline?: string,
): void {
  const paths = wikiPaths(workspaceRoot)
  if (layer === 'identity' || layer === 'preferences') {
    mkdirSync(workspaceRoot, { recursive: true })
    if (baseline !== undefined) {
      const current = readWikiLayer(workspaceRoot, layer)
      if (current !== baseline) throw new WikiWriteConflictError(layer, current)
    }
    writeFileSync(paths[layer], `${entry.content.trim()}\n`)
    return
  }
  mkdirSync(join(workspaceRoot, WIKI_LOG_SUBDIR), { recursive: true })
  const path = layer === 'timeline' ? paths.timeline : paths.decisions
  appendFileSync(path, renderLogEntry(entry))
}
