import { describe, expect, test } from 'bun:test'
import { ConsoleInbox } from '../../src/report/console-channel'

describe('ConsoleInbox notices', () => {
  test('notice cards carry kind and survive the ask prune window', () => {
    const inbox = new ConsoleInbox('zero')
    inbox.send('nick', 'should I proceed?')
    inbox.notice('api:default', 'Run 51 complete: gate traced to LEGO.INI read')
    const list = inbox.list()
    expect(list).toHaveLength(2)
    expect(list.find((a) => a.kind === 'notice')?.question).toContain('Run 51')

    // Two hours later: the ask (1h window) is abandoned, the notice (24h) survives.
    const now = Date.now() + 2 * 60 * 60 * 1000
    inbox.prune(60 * 60 * 1000, now)
    const after = inbox.list()
    expect(after).toHaveLength(1)
    expect(after[0]?.kind).toBe('notice')

    // Dismiss = resolve.
    expect(inbox.resolve(after[0]?.id as string)).toBe(true)
    expect(inbox.list()).toHaveLength(0)
  })
})
