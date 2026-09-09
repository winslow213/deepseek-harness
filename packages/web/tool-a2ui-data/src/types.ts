/**
 * Browser-safe type surface of the A2UI dynamic data-source capability: the
 * wire request/response the browser Remote namespace carries and the host
 * provider contract a deployment composes. Types only — no host-side value
 * imports — so a Client compilation face reads the same declarations the Host
 * emits.
 * @module @deepseek-ai/dsh-tool-a2ui-data/types
 */

import type { A2uiFieldOption } from '@deepseek-ai/dsh-tool-a2ui-surface/types'

/** Collected form values a data source may reference as command arguments. */
export type A2uiDataSourceArgs = Readonly<Record<string, string | number | boolean | null>>

/** One resolved data source: the select options it produced. */
export interface A2uiDataSourceResult {
  readonly items: readonly A2uiFieldOption[]
}

/** Wire request: resolve one named source into a select field's options. */
export interface A2uiDataResolveRequest {
  /** The stable source name declared on the `select` field. */
  readonly source: string
  /** Collected field values the provider may reference as arguments. */
  readonly args: A2uiDataSourceArgs
}

/** Wire response after a source resolves. */
export interface A2uiDataResolveValue {
  readonly items: readonly A2uiFieldOption[]
}
