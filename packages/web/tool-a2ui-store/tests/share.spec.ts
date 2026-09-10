/** Self-contained A2UI share tokens: encode/decode roundtrip and rejection. */

import { describe, expect, it } from 'vitest'
import type { A2uiFormPage } from '@deepseek-ai/dsh-tool-a2ui-surface/types'
import { A2UI_SHARE_PREFIX, decodeA2uiShareToken, encodeA2uiShareToken } from '../src/share.ts'

const page: A2uiFormPage = {
  kind: 'form',
  title: 'Deploy service',
  fields: [
    { name: 'env', label: 'Environment', type: 'select', options: [{ label: 'Prod', value: 'prod' }] },
    { name: 'confirm', label: 'Confirm', type: 'checkbox', required: true },
  ],
  actions: [{ id: 'deploy', label: 'Deploy', tool: 'run_deploy', instruction: 'Deploy now' }],
}

describe('encodeA2uiShareToken', () => {
  it('emits a prefixed, url-safe token', () => {
    const token = encodeA2uiShareToken('deploy-service', page)
    expect(token.startsWith(A2UI_SHARE_PREFIX)).toBe(true)
    expect(token).not.toContain('+')
    expect(token).not.toContain('/')
    expect(token).not.toContain('=')
  })
})

describe('decodeA2uiShareToken', () => {
  it('round-trips a token to its name and canonical page', () => {
    const token = encodeA2uiShareToken('deploy-service', page)
    const decoded = decodeA2uiShareToken(token)
    expect(decoded.name).toBe('deploy-service')
    expect(decoded.page.title).toBe('Deploy service')
    expect(decoded.page).toMatchObject({
      kind: 'form',
      actions: [{ id: 'deploy', label: 'Deploy', execution: 'model', tool: 'run_deploy', instruction: 'Deploy now' }],
    })
  })

  it('rejects a token without the prefix', () => {
    const token = encodeA2uiShareToken('deploy-service', page)
    expect(() => decodeA2uiShareToken(token.slice(A2UI_SHARE_PREFIX.length))).toThrow(/missing prefix/)
  })

  it('rejects an empty payload', () => {
    expect(() => decodeA2uiShareToken(A2UI_SHARE_PREFIX)).toThrow(/empty payload/)
  })

  it('rejects an oversized payload', () => {
    const big = `${A2UI_SHARE_PREFIX}${'a'.repeat(2_000_000)}`
    expect(() => decodeA2uiShareToken(big)).toThrow(/too large/)
  })

  it('rejects an undecodable payload', () => {
    expect(() => decodeA2uiShareToken(`${A2UI_SHARE_PREFIX}!!!not-base64url!!!`)).toThrow(/undecodable payload/)
  })

  it('rejects a payload that is not an object', () => {
    const notObject = Buffer.from('"just a string"', 'utf8').toString('base64url')
    expect(() => decodeA2uiShareToken(`${A2UI_SHARE_PREFIX}${notObject}`)).toThrow(/not an object/)
  })

  it('rejects an unsupported version', () => {
    const wrong = Buffer.from(JSON.stringify({ v: 99, name: 'x', page }), 'utf8').toString('base64url')
    expect(() => decodeA2uiShareToken(`${A2UI_SHARE_PREFIX}${wrong}`)).toThrow(/unsupported version/)
  })

  it('rejects an unsafe tool name', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, name: '../escape', page }), 'utf8').toString('base64url')
    expect(() => decodeA2uiShareToken(`${A2UI_SHARE_PREFIX}${bad}`)).toThrow(/unsafe tool name/)
  })

  it('rejects a missing page', () => {
    const missing = Buffer.from(JSON.stringify({ v: 1, name: 'x' }), 'utf8').toString('base64url')
    expect(() => decodeA2uiShareToken(`${A2UI_SHARE_PREFIX}${missing}`)).toThrow(/missing page/)
  })

  it('rejects a page that does not canonicalize', () => {
    const badPage = { kind: 'form', title: '  ', fields: [] }
    const token = `${A2UI_SHARE_PREFIX}${Buffer.from(JSON.stringify({ v: 1, name: 'x', page: badPage }), 'utf8').toString('base64url')}`
    expect(() => decodeA2uiShareToken(token)).toThrow(/invalid a2ui share token/)
  })
})
