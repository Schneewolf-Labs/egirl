import { describe, expect, test } from 'bun:test'
import { DEFAULT_VERBOSITY, makeVerbosityStore } from '../../src/session/verbosity'

describe('makeVerbosityStore', () => {
  test('defaults to tool-call lines on, reasoning off', () => {
    expect(makeVerbosityStore().get()).toEqual({ tools: true, thinking: false })
    expect(DEFAULT_VERBOSITY).toEqual({ tools: true, thinking: false })
  })

  test('an initial patch overrides only what it names', () => {
    expect(makeVerbosityStore({ thinking: true }).get()).toEqual({ tools: true, thinking: true })
  })

  test('set applies a partial change and returns the new state', () => {
    const v = makeVerbosityStore()
    expect(v.set({ tools: false })).toEqual({ tools: false, thinking: false })
    expect(v.set({ thinking: true })).toEqual({ tools: false, thinking: true })
    expect(v.get()).toEqual({ tools: false, thinking: true })
  })

  test('get returns a copy, not the live state', () => {
    const v = makeVerbosityStore()
    const snap = v.get()
    snap.tools = false
    expect(v.get().tools).toBe(true)
  })
})
