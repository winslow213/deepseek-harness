/**
 * A2UI dynamic data-source capability: the host provider contract
 * (`ctx.a2uiData`) that resolves a stable source name into a `select` field's
 * options, and the Remote controller (`ctx.remote.a2uiData`) the browser
 * launcher reaches. A deployment composes one provider — the shipped bash
 * provider, or its own — beside the surface tool; the popup requests a source
 * when a `select` field declares one instead of static options.
 * @module @deepseek-ai/dsh-tool-a2ui-data
 */

export type {
  A2uiDataSourceArgs,
  A2uiDataSourceResult,
  A2uiDataResolveRequest,
  A2uiDataResolveValue,
} from './types.ts'
export type { A2uiDataProvider } from './data.ts'
export { A2uiDataController } from './remote.ts'
