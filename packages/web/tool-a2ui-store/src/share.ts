/**
 * Self-contained A2UI tool share tokens: one saved tool (its name and
 * canonical page) encoded as a single URL-safe bearer token another user can
 * import. The token carries the whole page, so sharing needs no server-side
 * store — the recipient pastes the token and their deployment re-canonicalizes
 * and persists the page. The prefix and version are part of the wire format;
 * importing re-validates every field through `canonicalizeA2uiPage`, so a
 * token is never trusted beyond what a model-authored page already is.
 * @module @deepseek-ai/dsh-tool-a2ui-store/share
 */

import type { A2uiPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import { canonicalizeA2uiPage, type A2uiPageInput } from '@deepseek-ai/dsh-tool-a2ui-surface'
import { isSafeA2uiToolName } from './types.ts'

/** Stable token prefix; everything after it is the URL-safe base64 payload. */
export const A2UI_SHARE_PREFIX = 'a2ui-share:'

/** The share envelope version this module reads and writes. */
const A2UI_SHARE_VERSION = 1

/** Hard cap on a decoded token's encoded length, guarding against junk input. */
const A2UI_SHARE_MAX_ENCODED_LENGTH = 1_048_576

/** A share token's decoded payload: the tool name and its canonical page. */
export interface A2uiShareEnvelope {
  readonly name: string
  readonly page: A2uiPage
}

/**
 * Encode one saved tool as a shareable token. The token is the full page
 * JSON under a stable prefix, base64url-encoded so it pastes into a chat, a
 * link, or a file without escaping.
 * @param name - the tool's stable name.
 * @param page - the canonical page definition.
 * @returns the share token string.
 */
export function encodeA2uiShareToken(name: string, page: A2uiPage): string {
  const payload = Buffer.from(JSON.stringify({ v: A2UI_SHARE_VERSION, name, page }), 'utf8').toString('base64url')
  return `${A2UI_SHARE_PREFIX}${payload}`
}

/**
 * Decode a share token into its name and canonical page, rejecting anything
 * that is not a well-formed, bounded, validly-canonicalized tool. This is the
 * import boundary: the token is untrusted input, so every field is re-validated.
 * @param token - the share token string to decode.
 * @returns the decoded name and canonical page.
 * @throws {Error} on a malformed, oversized, wrong-version, or invalid-page token.
 */
export function decodeA2uiShareToken(token: string): A2uiShareEnvelope {
  if (typeof token !== 'string' || !token.startsWith(A2UI_SHARE_PREFIX)) {
    throw new Error('invalid a2ui share token: missing prefix')
  }
  const encoded = token.slice(A2UI_SHARE_PREFIX.length)
  if (encoded.length === 0) {
    throw new Error('invalid a2ui share token: empty payload')
  }
  if (encoded.length > A2UI_SHARE_MAX_ENCODED_LENGTH) {
    throw new Error('invalid a2ui share token: payload too large')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new Error('invalid a2ui share token: undecodable payload')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('invalid a2ui share token: payload is not an object')
  }
  const { v, name, page } = parsed as Record<string, unknown>
  if (v !== A2UI_SHARE_VERSION) {
    throw new Error('invalid a2ui share token: unsupported version')
  }
  if (typeof name !== 'string' || !isSafeA2uiToolName(name)) {
    throw new Error('invalid a2ui share token: unsafe tool name')
  }
  if (typeof page !== 'object' || page === null) {
    throw new Error('invalid a2ui share token: missing page')
  }
  try {
    return { name, page: canonicalizeA2uiPage(page as A2uiPageInput) }
  } catch (error) {
    /* v8 ignore next -- canonicalizeA2uiPage throws Error, so the non-Error fallback is unreachable */
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid a2ui share token: ${reason}`)
  }
}
