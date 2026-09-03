/** Browser-side trusted-authority semantics shared with the Host /api fence. */

import { describe, expect, it } from 'vitest'
import { isTrustedPageAuthority } from '../src/trusted-hostname.ts'

function page(hostname: string, port?: number): URL {
  return new URL(`http://${hostname}${port === undefined ? '' : `:${String(port)}`}/`)
}

describe('isTrustedPageAuthority', () => {
  it('matches a port-less entry against the hostname on any port', () => {
    const trusted = ['10.33.2.56']
    expect(isTrustedPageAuthority(page('10.33.2.56'), trusted)).toBe(true)
    expect(isTrustedPageAuthority(page('10.33.2.56', 3999), trusted)).toBe(true)
  })

  it('matches an explicit host:port entry only against the exact authority', () => {
    const trusted = ['dsh.test:3999']
    expect(isTrustedPageAuthority(page('dsh.test', 3999), trusted)).toBe(true)
    expect(isTrustedPageAuthority(page('dsh.test', 4000), trusted)).toBe(false)
    expect(isTrustedPageAuthority(page('dsh.test'), trusted)).toBe(false)
  })

  it('refuses an unlisted hostname', () => {
    const trusted = ['10.33.2.56', 'dsh.test']
    expect(isTrustedPageAuthority(page('192.168.1.10'), trusted)).toBe(false)
    expect(isTrustedPageAuthority(page('other.internal'), trusted)).toBe(false)
  })

  it('never matches on an empty trusted list', () => {
    expect(isTrustedPageAuthority(page('10.33.2.56'), [])).toBe(false)
  })

  it('ignores a malformed entry rather than throwing', () => {
    const trusted = ['not a valid authority ::']
    expect(isTrustedPageAuthority(page('10.0.0.1'), trusted)).toBe(false)
  })
})
