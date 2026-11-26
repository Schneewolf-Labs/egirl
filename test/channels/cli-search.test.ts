import { describe, expect, test } from 'bun:test'
import { createHistorySearch } from '../../src/channels/cli-search'

// Newest first, as readline keeps it.
const history = ['bun test test/channels', '/status', 'bun test test/agent', 'git status']

describe('Ctrl-R history search', () => {
  test('finds the newest entry containing the query, ignoring case', () => {
    const s = createHistorySearch(() => history)
    s.start('half typed')
    expect(s.isActive).toBe(true)
    expect(s.match()).toBeUndefined()
    s.setQuery('STATUS')
    expect(s.match()).toBe('/status')
    s.setQuery('nothing like it')
    expect(s.match()).toBeUndefined()
  })

  test('Ctrl-R again steps older, and stays on the oldest match', () => {
    const s = createHistorySearch(() => history)
    s.start('')
    s.setQuery('bun')
    expect(s.match()).toBe('bun test test/channels')
    s.older()
    expect(s.match()).toBe('bun test test/agent')
    s.older()
    expect(s.match()).toBe('bun test test/agent')
  })

  test('a line typed twice is one match', () => {
    const s = createHistorySearch(() => ['ls', 'make', 'make', 'make all'])
    s.start('')
    s.setQuery('make')
    s.older()
    expect(s.match()).toBe('make all')
  })

  test('the match survives history shifting under it, and stop gives back the line', () => {
    const live = [...history]
    const s = createHistorySearch(() => live)
    s.start('draft')
    s.setQuery('agent')
    live.unshift('agent') // readline adds the query on enter, before the line event
    expect(s.match()).toBe('bun test test/agent')
    expect(s.stop()).toBe('draft')
    expect(s.isActive).toBe(false)
    expect(s.match()).toBeUndefined()
  })
})
