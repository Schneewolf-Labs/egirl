import { describe, expect, test } from 'bun:test'
import { describeAllowList, isAllowedByList } from '../../src/channels/allowlist'

const matchExact = (id: string) => (entry: string) => entry === id

describe('isAllowedByList', () => {
  test('empty list denies everyone (fail closed)', () => {
    expect(isAllowedByList([], matchExact('nick'))).toBe(false)
  })

  test('"*" allows everyone (explicit opt-in)', () => {
    expect(isAllowedByList(['*'], matchExact('nick'))).toBe(true)
    expect(isAllowedByList(['*'], matchExact('stranger'))).toBe(true)
  })

  test('a populated list admits only matching entries', () => {
    expect(isAllowedByList(['nick', 'boss'], matchExact('nick'))).toBe(true)
    expect(isAllowedByList(['nick', 'boss'], matchExact('stranger'))).toBe(false)
  })

  test('"*" alongside other entries still opens up', () => {
    expect(isAllowedByList(['boss', '*'], matchExact('stranger'))).toBe(true)
  })
})

describe('describeAllowList', () => {
  test('names the empty, open, and explicit cases', () => {
    expect(describeAllowList([])).toContain('no one')
    expect(describeAllowList(['*'])).toContain('everyone')
    expect(describeAllowList(['a', 'b'])).toBe('a, b')
  })
})
