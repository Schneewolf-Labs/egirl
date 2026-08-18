/**
 * `$VAR` expansion in MCP `env` and `headers`.
 *
 * The bug this pins: substitution fired only when a value was *exactly* `$VAR`, so the natural
 * `"Bearer $TOKEN"` went out verbatim. The server then rejects a credential that reads
 * literally `Bearer $TOKEN`, which is indistinguishable from a bad token at the far end — a
 * long way to walk for a missing substitution.
 */
import { describe, expect, test } from 'bun:test'
import { expandEnvVars } from '../../src/config/index'

describe('mcp $VAR expansion', () => {
  test('expands a variable embedded in a larger string', () => {
    process.env.WALD_TEST_TOKEN = 'secret123'
    expect(expandEnvVars({ Authorization: 'Bearer $WALD_TEST_TOKEN' })).toEqual({
      Authorization: 'Bearer secret123',
    })
  })

  test('still expands a bare $VAR', () => {
    process.env.WALD_TEST_TOKEN = 'secret123'
    expect(expandEnvVars({ k: '$WALD_TEST_TOKEN' })).toEqual({ k: 'secret123' })
  })

  test('supports ${BRACED} form', () => {
    process.env.WALD_TEST_TOKEN = 'secret123'
    expect(expandEnvVars({ k: '${WALD_TEST_TOKEN}' })).toEqual({ k: 'secret123' })
  })

  test('an unset variable expands to empty rather than staying literal', () => {
    // A header visibly missing its token fails immediately; `$VAR` on the wire invites the
    // reader to believe a value was sent.
    delete process.env.WALD_UNSET_XYZ
    expect(expandEnvVars({ k: 'Bearer $WALD_UNSET_XYZ' })).toEqual({ k: 'Bearer ' })
  })

  test('leaves strings without variables untouched', () => {
    expect(expandEnvVars({ k: 'no vars here', j: 'cost is 5 dollars' })).toEqual({
      k: 'no vars here',
      j: 'cost is 5 dollars',
    })
  })

  test('expands several variables in one value', () => {
    process.env.WALD_A = 'a'
    process.env.WALD_B = 'b'
    expect(expandEnvVars({ k: '$WALD_A/$WALD_B' })).toEqual({ k: 'a/b' })
  })
})
