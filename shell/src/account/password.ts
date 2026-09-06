/**
 * Password hashing with node:crypto scrypt — zero external dependency. Salt
 * is random per hash; verification uses timingSafeEqual so a failed compare
 * leaks nothing about the stored value.
 *
 * Format: `scrypt$N$r$p$<salt-b64url>$<hash-b64url>` (N/r/p are the scrypt
 * cost parameters, fixed at OWASP-recommended values so the stored form stays
 * self-describing if parameters ever change).
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const SCRYPT_N = 2 ** 17
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 64
const SALT_BYTES = 16
/** scrypt maxmem must exceed N*r*128 bytes; 2^17,8 needs ~128 MiB. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024
const PREFIX = 'scrypt'

function toBase64Url(value: Buffer): string {
  return value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function fromBase64Url(value: string): Buffer {
  const padding = '='.repeat((4 - value.length % 4) % 4)
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
}

/** Hash one password into the stored form. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES)
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM })
  return [PREFIX, SCRYPT_N, SCRYPT_R, SCRYPT_P, toBase64Url(salt), toBase64Url(hash)].join('$')
}

/** Verify one password against a stored hash; false for malformed records. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== PREFIX) return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n <= 0 || r <= 0 || p <= 0) return false
  const salt = fromBase64Url(parts[4] ?? '')
  const expected = fromBase64Url(parts[5] ?? '')
  if (salt.byteLength === 0 || expected.byteLength !== KEY_LENGTH) return false
  const actual = scryptSync(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: SCRYPT_MAXMEM })
  return timingSafeEqual(actual, expected)
}
