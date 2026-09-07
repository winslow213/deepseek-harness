/**
 * Restricted, side-effect-free expression evaluator for A2UI field logic
 * (`visibleWhen`, `validateWhen`, `compute`). The model authors expressions
 * that the browser must evaluate without running arbitrary model text, so this
 * module parses and evaluates a small grammar with a recursive-descent
 * interpreter — no `eval`, no `new Function`, and no reach into ambient
 * globals. Anything outside the grammar throws, so a malformed expression
 * fails loud at render time instead of being silently ignored.
 *
 * Grammar (lowest to highest precedence):
 *
 *   or         := and ('||' and)*
 *   and        := equality ('&&' equality)*
 *   equality   := comparison (('==='|'!=='|'=='|'!=') comparison)*
 *   comparison := additive (('<'|'<='|'>'|'>=') additive)*
 *   additive   := multiplicative (('+'|'-') multiplicative)*
 *   multiplicative := unary (('*'|'/'|'%') unary)*
 *   unary      := ('!'|'+'|'-')* postfix
 *   postfix    := primary ('.' member)*
 *   primary    := number | string | 'true' | 'false' | 'null'
 *               | identifier        -- sibling field reference
 *               | '(' or ')'
 *   member     := 'length'                                  -- string length
 *               | ('trim'|'toLowerCase'|'toUpperCase') '(' ')'
 *               | ('includes'|'startsWith'|'endsWith') '(' or ')'
 *
 * @module @deepseek-ai/dsh-client-ui-a2ui/expression
 */

/** Values the expression reads: field values keyed by sibling field name. */
export type A2uiValues = Readonly<Record<string, string | number | boolean | null>>

/** Token kinds the tokenizer produces. */
type TokenKind = 'number' | 'string' | 'identifier' | 'op' | 'lparen' | 'rparen' | 'dot' | 'eof'

/** One lexical token with its literal payload for number/string/identifier. */
interface Token {
  readonly kind: TokenKind
  /** Operator text for `op`; the source spelling otherwise. */
  readonly text: string
  /** Pre-parsed literal for number/string and the boolean/null keywords; undefined otherwise. */
  readonly literal?: string | number | boolean | null
}

/** String member names that take zero arguments (invoked with `()`). */
const STRING_ZERO_ARG_METHODS = new Set(['trim', 'toLowerCase', 'toUpperCase'])

/** String member names that take exactly one argument. */
const STRING_ONE_ARG_METHODS = new Set(['includes', 'startsWith', 'endsWith'])

/**
 * Tokenize the expression into a flat token stream. Only the grammar's
 * punctuation and keywords are recognized; anything else aborts with a
 * `SyntaxError` naming the offending position.
 * @param source - the model-authored expression text.
 * @returns the token stream terminated by an `eof` token.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const push = (token: Token): void => { tokens.push(token) }
  while (i < source.length) {
    const ch = source.charAt(i)
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue }
    if (ch >= '0' && ch <= '9') {
      const start = i
      while (i < source.length && source.charAt(i) >= '0' && source.charAt(i) <= '9') i += 1
      if (source.charAt(i) === '.') {
        i += 1
        while (i < source.length && source.charAt(i) >= '0' && source.charAt(i) <= '9') i += 1
      }
      push({ kind: 'number', text: source.slice(start, i), literal: Number(source.slice(start, i)) })
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      const start = i
      let value = ''
      i += 1
      for (;;) {
        if (i >= source.length) throw new SyntaxError(`unterminated string literal at ${start}`)
        const c = source.charAt(i)
        if (c === '\\') {
          const next = source.charAt(i + 1)
          if (next === quote || next === '\\') { value += next; i += 2; continue }
          throw new SyntaxError(`unsupported escape \\${next} at ${i}`)
        }
        if (c === quote) { i += 1; break }
        value += c
        i += 1
      }
      push({ kind: 'string', text: value, literal: value })
      continue
    }
    if (isIdentifierStart(ch)) {
      const start = i
      while (i < source.length && isIdentifierPart(source.charAt(i))) i += 1
      const word = source.slice(start, i)
      if (word === 'true' || word === 'false' || word === 'null') {
        push({ kind: 'identifier', text: word, literal: word === 'true' ? true : word === 'false' ? false : null })
        continue
      }
      push({ kind: 'identifier', text: word })
      continue
    }
    const three = ch + source.charAt(i + 1) + source.charAt(i + 2)
    if (three === '===' || three === '!==') {
      push({ kind: 'op', text: three })
      i += 3
      continue
    }
    const two = ch + source.charAt(i + 1)
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
      push({ kind: 'op', text: two })
      i += 2
      continue
    }
    if (ch === '<' || ch === '>' || ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%' || ch === '!') {
      push({ kind: 'op', text: ch })
      i += 1
      continue
    }
    if (ch === '(') { push({ kind: 'lparen', text: ch }); i += 1; continue }
    if (ch === ')') { push({ kind: 'rparen', text: ch }); i += 1; continue }
    if (ch === '.') { push({ kind: 'dot', text: ch }); i += 1; continue }
    throw new SyntaxError(`unexpected character ${JSON.stringify(ch)} at ${i}`)
  }
  push({ kind: 'eof', text: '' })
  return tokens
}

/** Whether a character may begin an identifier (a field name or a keyword). */
function isIdentifierStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'
}

/** Whether a character may continue an identifier. */
function isIdentifierPart(ch: string): boolean {
  return isIdentifierStart(ch) || (ch >= '0' && ch <= '9')
}

/** Terminal token the evaluator falls back to past the end of the stream. */
const EOF_TOKEN: Token = { kind: 'eof', text: '' }

/** The evaluator over a token stream: one token of lookahead, recursive descent. */
class Evaluator {
  private pos = 0

  constructor(private readonly tokens: Token[], private readonly values: A2uiValues) {}

  /** Evaluate the whole expression; throws on any grammar or type error. */
  evaluate(): string | number | boolean | null {
    const value = this.or()
    if (this.peek().kind !== 'eof') throw new SyntaxError(`unexpected token ${JSON.stringify(this.peek().text)}`)
    return value
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? EOF_TOKEN
  }

  private next(): Token {
    const token = this.tokens[this.pos] ?? EOF_TOKEN
    this.pos += 1
    return token
  }

  private or(): string | number | boolean | null {
    let left = this.and()
    while (this.peek().kind === 'op' && this.peek().text === '||') {
      this.next()
      const right = this.and()
      left = truthy(left) ? left : right
    }
    return left
  }

  private and(): string | number | boolean | null {
    let left = this.equality()
    while (this.peek().kind === 'op' && this.peek().text === '&&') {
      this.next()
      const right = this.equality()
      left = truthy(left) ? right : left
    }
    return left
  }

  private equality(): string | number | boolean | null {
    let left = this.comparison()
    for (;;) {
      const op = this.peek().text
      if (this.peek().kind !== 'op' || !['===', '!==', '==', '!='].includes(op)) return left
      this.next()
      const right = this.comparison()
      if (op === '===') left = left === right
      else if (op === '!==') left = left !== right
      else if (op === '==') left = left == right
      else left = left != right
    }
  }

  private comparison(): string | number | boolean | null {
    let left = this.additive()
    for (;;) {
      const op = this.peek().text
      if (this.peek().kind !== 'op' || !['<', '<=', '>', '>='].includes(op)) return left
      this.next()
      const right = this.additive()
      left = compare(op, left, right)
    }
  }

  private additive(): string | number | boolean | null {
    let left = this.multiplicative()
    for (;;) {
      const op = this.peek().text
      if (this.peek().kind !== 'op' || (op !== '+' && op !== '-')) return left
      this.next()
      const right = this.multiplicative()
      left = arithmetic(op, left, right)
    }
  }

  private multiplicative(): string | number | boolean | null {
    let left = this.unary()
    for (;;) {
      const op = this.peek().text
      if (this.peek().kind !== 'op' || (op !== '*' && op !== '/' && op !== '%')) return left
      this.next()
      const right = this.unary()
      left = arithmetic(op, left, right)
    }
  }

  private unary(): string | number | boolean | null {
    if (this.peek().kind === 'op' && this.peek().text === '!') {
      this.next()
      return truthy(this.unary()) ? false : true
    }
    if (this.peek().kind === 'op' && this.peek().text === '-') {
      this.next()
      const operand = this.unary()
      if (typeof operand !== 'number') throw new TypeError('unary `-` requires a number')
      return -operand
    }
    if (this.peek().kind === 'op' && this.peek().text === '+') {
      this.next()
      const operand = this.unary()
      if (typeof operand !== 'number') throw new TypeError('unary `+` requires a number')
      return operand
    }
    return this.postfix()
  }

  private postfix(): string | number | boolean | null {
    let value = this.primary()
    while (this.peek().kind === 'dot') {
      this.next()
      const member = this.next()
      if (member.kind !== 'identifier') throw new SyntaxError('expected a member name after `.`')
      if (member.text === 'length') {
        if (typeof value !== 'string') throw new TypeError('`.length` requires a string')
        value = value.length
        continue
      }
      if (STRING_ZERO_ARG_METHODS.has(member.text)) {
        this.expectParens(0)
        if (typeof value !== 'string') throw new TypeError(`\`.${member.text}()\` requires a string`)
        if (member.text === 'trim') value = value.trim()
        else if (member.text === 'toLowerCase') value = value.toLowerCase()
        else value = value.toUpperCase()
        continue
      }
      if (STRING_ONE_ARG_METHODS.has(member.text)) {
        const arg = this.expectParens(1)
        if (typeof value !== 'string' || typeof arg !== 'string') throw new TypeError(`\`.${member.text}(x)\` requires two strings`)
        if (member.text === 'includes') value = value.includes(arg)
        else if (member.text === 'startsWith') value = value.startsWith(arg)
        else value = value.endsWith(arg)
        continue
      }
      throw new SyntaxError(`unknown string member ${JSON.stringify(member.text)}`)
    }
    return value
  }

  /** Consume a parenthesized argument list, returning the single evaluated argument (or null for zero args). */
  private expectParens(argCount: 0 | 1): string | number | boolean | null {
    if (this.peek().kind !== 'lparen') throw new SyntaxError('expected an opening parenthesis before arguments')
    this.next()
    if (argCount === 0) {
      if (this.peek().kind !== 'rparen') throw new SyntaxError('expected no arguments')
      this.next()
      return null
    }
    const arg = this.or()
    if (this.peek().kind !== 'rparen') throw new SyntaxError('expected exactly one argument')
    this.next()
    return arg
  }

  private primary(): string | number | boolean | null {
    const token = this.next()
    if (token.kind === 'number' || token.kind === 'string') return token.literal as string | number
    if (token.kind === 'lparen') {
      const value = this.or()
      if (this.peek().kind !== 'rparen') throw new SyntaxError('expected `)`')
      this.next()
      return value
    }
    if (token.kind === 'identifier') {
      // `true`/`false`/`null` already carry their literal; a bare identifier is a field reference.
      if (token.literal !== undefined) return token.literal as string | number | boolean | null
      if (!(token.text in this.values)) throw new ReferenceError(`unknown field ${JSON.stringify(token.text)}`)
      return this.values[token.text] ?? null
    }
    throw new SyntaxError(`unexpected token ${JSON.stringify(token.text)}`)
  }
}

/** JavaScript truthiness of an evaluated value. */
function truthy(value: string | number | boolean | null): boolean {
  return Boolean(value)
}

/** Apply a comparison operator, coercing only same-typed operands. */
function compare(op: string, left: string | number | boolean | null, right: string | number | boolean | null): boolean {
  if (op === '<') return lt(left, right)
  if (op === '<=') return lt(left, right) || left === right
  if (op === '>') return lt(right, left)
  return lt(right, left) || left === right
}

/** Strict numeric/string less-than; mixed types are a type error. */
function lt(left: string | number | boolean | null, right: string | number | boolean | null): boolean {
  if (typeof left === 'number' && typeof right === 'number') return left < right
  if (typeof left === 'string' && typeof right === 'string') return left < right
  throw new TypeError('`<`/`<=`/`>`/`>=` require two numbers or two strings')
}

/** Apply an arithmetic operator with type checking. */
function arithmetic(
  op: string,
  left: string | number | boolean | null,
  right: string | number | boolean | null,
): string | number | boolean | null {
  if (op === '+') {
    if (typeof left === 'number' && typeof right === 'number') return left + right
    if (typeof left === 'string' && typeof right === 'string') return left + right
    throw new TypeError('`+` requires two numbers or two strings')
  }
  if (typeof left !== 'number' || typeof right !== 'number') throw new TypeError(`\`${op}\` requires two numbers`)
  if (op === '-') return left - right
  if (op === '*') return left * right
  if (op === '/') return left / right
  return left % right
}

/**
 * Evaluate a model-authored A2UI expression against sibling field values.
 * @param expression - the expression text (already trimmed non-empty).
 * @param values - field values keyed by field name.
 * @returns the expression's value; `visibleWhen`/`validateWhen` treat falsy as
 *   hidden/invalid, `compute` displays the raw result.
 * @throws {SyntaxError|ReferenceError|TypeError} on any grammar, field, or
 *   type error — the caller renders the failure rather than ignoring it.
 */
export function evaluateA2uiExpression(expression: string, values: A2uiValues): string | number | boolean | null {
  return new Evaluator(tokenize(expression), values).evaluate()
}
