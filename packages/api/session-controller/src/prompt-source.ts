/** Durable message source for one prompt admitted through the Remote surface. */

import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionPromptContext, SessionPromptRequest } from './types.ts'

/**
 * Bundle one prompt's source metadata.
 *
 * A prompt carrying plugin context is logged as a notice rather than a user
 * message, so the chat renders a collapsed context row while the model still
 * receives the content. The user form records the caller only when it is not
 * the owner, so owner messages keep their exact source.
 *
 * @param request - prompt request supplying the request id and optional context.
 * @param principal - non-owner caller identity, or undefined for the owner.
 * @param clientTimeZone - normalized client time zone, or undefined when absent.
 * @returns the message source the durable log records.
 */
export function promptMessageSource(
  request: SessionPromptRequest,
  principal: Principal | undefined,
  clientTimeZone: string | undefined,
): MessageSource {
  const context: SessionPromptContext | undefined = request.context
  if (context !== undefined) {
    return { kind: 'prompt-context', plugin: context.plugin, form: 'notice', summary: context.summary }
  }
  return {
    kind: 'user',
    rpcId: request.requestId,
    ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    ...(principal === undefined ? {} : { principal }),
  }
}
