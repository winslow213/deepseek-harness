/**
 * Host capability contract for A2UI dynamic data sources: a provider resolves
 * a stable source name into a `select` field's options. The provider is a
 * composition choice — a deployment composes exactly one implementation (the
 * shipped bash provider, or its own) beside the surface tool, and the
 * browser-side Remote namespace reaches it through `ctx.a2uiData`.
 * @module @deepseek-ai/dsh-tool-a2ui-data/data
 */

import type { A2uiDataSourceArgs, A2uiDataSourceResult } from './types.ts'

export type { A2uiDataSourceArgs, A2uiDataSourceResult } from './types.ts'

/** Host capability resolving a named source into select options. */
export interface A2uiDataProvider {
  /**
   * Whether this provider knows the named source. A source outside the
   * provider's whitelist is refused before any command runs.
   * @param source - the stable source name declared on a `select` field.
   * @returns true when {@link resolve} can serve the source.
   */
  has(source: string): boolean
  /**
   * Resolve one source into select options.
   * @param source - the stable source name declared on a `select` field.
   * @param args - collected field values the provider may reference.
   * @returns the resolved options.
   * @throws for an unknown source or a provider that cannot serve it.
   */
  resolve(source: string, args: A2uiDataSourceArgs): Promise<A2uiDataSourceResult>
}
