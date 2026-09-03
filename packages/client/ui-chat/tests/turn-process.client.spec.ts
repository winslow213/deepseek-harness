import { describe, expect, it } from 'vitest'
import type { ChatConversationViewNode } from '../src/client/contract/chat-nodes.ts'
import { isTurnProcessIndependent } from '../src/client/contract/turn-process.ts'

/**
 * Build a minimal view-node of any kind for predicate tests. The predicate
 * reads only `kind` and `turnProcessIndependent`; `kind` must be typed via a
 * cast because a test may exercise a kind contributed by another module (the
 * a2ui page) that this package's own program cannot name.
 */
function nodeOf(kind: string, independent?: boolean): ChatConversationViewNode {
  return {
    key: `k-${kind}`,
    kind,
    id: `id-${kind}`,
    target: 'chat',
    anchorSeq: 1,
    location: { kind: 'session' },
    visibility: 'visible',
    data: undefined,
    ...independent === undefined ? {} : { turnProcessIndependent: independent },
  } as unknown as ChatConversationViewNode
}

describe('isTurnProcessIndependent', () => {
  it('treats built-in transcript kinds as independent', () => {
    for (const kind of ['user', 'steering', 'system-prompt', 'turn-process', 'turn-error', 'turn-tail']) {
      expect(isTurnProcessIndependent(nodeOf(kind))).toBe(true)
    }
  })

  it('treats ordinary mid-turn process kinds as foldable', () => {
    expect(isTurnProcessIndependent(nodeOf('tool-call'))).toBe(false)
    expect(isTurnProcessIndependent(nodeOf('assistant-step'))).toBe(false)
    expect(isTurnProcessIndependent(nodeOf('context'))).toBe(false)
  })

  it('honors a per-node independent flag for a contributed durable surface kind', () => {
    expect(isTurnProcessIndependent(nodeOf('a2ui-surface', true))).toBe(true)
  })

  it('keeps a contributed kind foldable when it lacks the flag', () => {
    expect(isTurnProcessIndependent(nodeOf('a2ui-surface'))).toBe(false)
  })
})
