/**
 * Host Remote owner for the A2UI dynamic data-source capability: the
 * `ctx.remote.a2uiData` namespace resolves one named source into a `select`
 * field's options. The browser launcher reaches it when a page declares a
 * `source` on a `select` field; the host provider (`ctx.a2uiData`) runs the
 * read and the result returns to the popup through the opener.
 * @module @deepseek-ai/dsh-tool-a2ui-data/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { A2uiDataProvider } from './data.ts'
import type { A2uiDataResolveRequest, A2uiDataResolveValue } from './types.ts'

export type { A2uiDataResolveRequest, A2uiDataResolveValue } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The A2UI dynamic data-source capability: resolve a named source into select options. */
    a2uiData: A2uiDataProvider
    /** Host owner of the `a2uiData` Remote namespace. */
    a2uiDataController: A2uiDataController
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The named source is not registered by any composed provider. */
    'a2ui-data/unknown-source': { readonly source: string }
  }
}

/**
 * Host service backing `ctx.remote.a2uiData`: resolve one source into select
 * options through the composed provider.
 */
export class A2uiDataController extends TypertRemoteService {
  static inject = ['a2uiData', 'typert']

  /** @param ctx - Host context carrying the data-provider capability. */
  constructor(ctx: Context) {
    super(ctx, 'a2uiDataController', { namespace: 'a2uiData' })
  }

  /**
   * Resolve one source into its select options.
   * @param request - the source name and collected field values.
   * @returns the resolved options.
   */
  @Remote('resolve')
  async resolve(request: A2uiDataResolveRequest): Promise<A2uiDataResolveValue> {
    if (!this.ctx.a2uiData.has(request.source)) {
      throw new RemoteError(
        'a2ui-data/unknown-source',
        `no provider registers the a2ui data source "${request.source}"`,
        { source: request.source },
      )
    }
    const result = await this.ctx.a2uiData.resolve(request.source, request.args)
    return { items: result.items }
  }
}
