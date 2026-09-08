/** Behavior of the restricted A2UI expression evaluator. */

import { describe, expect, it } from 'vitest'
import { evaluateA2uiExpression } from '../src/a2ui-expression.ts'

describe('evaluateA2uiExpression', () => {
  it('evaluates literals', () => {
    expect(evaluateA2uiExpression('42', {})).toBe(42)
    expect(evaluateA2uiExpression('3.5', {})).toBe(3.5)
    expect(evaluateA2uiExpression("'hello'", {})).toBe('hello')
    expect(evaluateA2uiExpression('"world"', {})).toBe('world')
    expect(evaluateA2uiExpression('true', {})).toBe(true)
    expect(evaluateA2uiExpression('false', {})).toBe(false)
    expect(evaluateA2uiExpression('null', {})).toBe(null)
  })

  it('resolves sibling field references', () => {
    expect(evaluateA2uiExpression('name', { name: 'alice' })).toBe('alice')
    expect(evaluateA2uiExpression('count', { count: 7 })).toBe(7)
    expect(evaluateA2uiExpression('flag', { flag: true })).toBe(true)
  })

  it('applies arithmetic with precedence and grouping', () => {
    expect(evaluateA2uiExpression('1 + 2 * 3', {})).toBe(7)
    expect(evaluateA2uiExpression('(1 + 2) * 3', {})).toBe(9)
    expect(evaluateA2uiExpression('10 - 4 - 2', {})).toBe(4)
    expect(evaluateA2uiExpression('10 / 4', {})).toBe(2.5)
    expect(evaluateA2uiExpression('10 % 4', {})).toBe(2)
    expect(evaluateA2uiExpression('-3', {})).toBe(-3)
    expect(evaluateA2uiExpression('+3', {})).toBe(3)
    expect(evaluateA2uiExpression('a * b', { a: 3, b: 4 })).toBe(12)
  })

  it('concatenates strings with +', () => {
    expect(evaluateA2uiExpression("'a' + 'b'", {})).toBe('ab')
    expect(evaluateA2uiExpression('first + last', { first: 'foo', last: 'bar' })).toBe('foobar')
  })

  it('compares with equality and ordering operators', () => {
    expect(evaluateA2uiExpression('1 === 1', {})).toBe(true)
    expect(evaluateA2uiExpression('1 !== 2', {})).toBe(true)
    expect(evaluateA2uiExpression("'a' < 'b'", {})).toBe(true)
    expect(evaluateA2uiExpression('2 >= 2', {})).toBe(true)
    expect(evaluateA2uiExpression('age >= 18', { age: 20 })).toBe(true)
    expect(evaluateA2uiExpression('name === "bob"', { name: 'bob' })).toBe(true)
  })

  it('short-circuits and/or and negates with !', () => {
    expect(evaluateA2uiExpression('true && false', {})).toBe(false)
    expect(evaluateA2uiExpression('false || true', {})).toBe(true)
    expect(evaluateA2uiExpression('!true', {})).toBe(false)
    expect(evaluateA2uiExpression('a && b', { a: 1, b: 0 })).toBe(0)
    expect(evaluateA2uiExpression('a || b', { a: '', b: 'fallback' })).toBe('fallback')
  })

  it('applies the string member helpers', () => {
    expect(evaluateA2uiExpression("'abc'.length", {})).toBe(3)
    expect(evaluateA2uiExpression("'  x  '.trim()", {})).toBe('x')
    expect(evaluateA2uiExpression("'abc'.includes('b')", {})).toBe(true)
    expect(evaluateA2uiExpression("'abc'.startsWith('a')", {})).toBe(true)
    expect(evaluateA2uiExpression("'abc'.endsWith('c')", {})).toBe(true)
    expect(evaluateA2uiExpression('"ABC".toLowerCase()', {})).toBe('abc')
    expect(evaluateA2uiExpression('"abc".toUpperCase()', {})).toBe('ABC')
    expect(evaluateA2uiExpression('name.trim().length > 0', { name: '  ' })).toBe(false)
  })

  it('evaluates a realistic visibility condition', () => {
    const values = { hasEmail: true, email: 'a@b.c' }
    expect(evaluateA2uiExpression('hasEmail === true', values)).toBe(true)
    expect(evaluateA2uiExpression('hasEmail && email.trim().length > 0', values)).toBe(true)
  })

  it('rejects an unknown field reference', () => {
    expect(() => evaluateA2uiExpression('missing', {})).toThrow('unknown field')
  })

  it('rejects syntax it does not recognize', () => {
    expect(() => evaluateA2uiExpression('a ? b : c', { a: 1, b: 2, c: 3 })).toThrow()
    expect(() => evaluateA2uiExpression('[1,2]', {})).toThrow()
    expect(() => evaluateA2uiExpression('{a:1}', {})).toThrow()
    expect(() => evaluateA2uiExpression('Math.max(1,2)', {})).toThrow()
    expect(() => evaluateA2uiExpression("'x'.substring(1)", {})).toThrow('unknown string member')
    expect(() => evaluateA2uiExpression('a & b', { a: 1, b: 2 })).toThrow()
    expect(() => evaluateA2uiExpression('1 +', {})).toThrow()
  })

  it('rejects type mismatches instead of coercing', () => {
    expect(() => evaluateA2uiExpression('1 - "a"', {})).toThrow()
    expect(() => evaluateA2uiExpression('1 < "a"', {})).toThrow()
    expect(() => evaluateA2uiExpression('"a" * 2', {})).toThrow()
    expect(evaluateA2uiExpression('1 && 2', {})).toBe(2) // truthiness, not a type error
  })
})
