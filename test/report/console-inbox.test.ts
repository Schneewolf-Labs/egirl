/**
 * The console as a report target.
 *
 * The interesting part is attribution. `send(target, message)` receives the *target* — who the
 * answer routes back through — and the first version stored that as the asker, so every card in
 * the inbox was captioned with the name of the person reading it: "nick is asking you". The two
 * identities have to stay distinct, because one labels the card and the other routes the reply.
 */

import { describe, expect, test } from 'bun:test'
import { createReplyBroker } from '../../src/report/broker'
import { ConsoleInbox } from '../../src/report/console-channel'

describe('ConsoleInbox', () => {
  test('attributes an ask to the asking instance, not the person answering', async () => {
    const inbox = new ConsoleInbox('emma')
    await inbox.send('nick', '[report from emma] should we accept?')
    const ask = inbox.list()[0]
    expect(ask?.from).toBe('emma') // shown on the card
    expect(ask?.target).toBe('nick') // used to route the answer back
  })

  test('an answer reaches the run parked on it', async () => {
    // End to end through the real broker: the report tool parks on (channel, target), and the
    // console's reply has to be delivered on that same key or the agent waits out its timeout
    // for an answer that was already given.
    const inbox = new ConsoleInbox('emma')
    const broker = createReplyBroker()
    const parked = broker.awaitReply('console', 'nick', 5000)
    await inbox.send('nick', 'question')
    const ask = inbox.list()[0]
    expect(broker.tryDeliver('console', ask?.target as string, 'do (a)')).toBe(true)
    expect(await parked).toBe('do (a)')
  })

  test('resolving removes it so it cannot be answered twice', async () => {
    const inbox = new ConsoleInbox('emma')
    await inbox.send('nick', 'q')
    expect(inbox.resolve('ask1')).toBe(true)
    expect(inbox.list()).toEqual([])
    expect(inbox.resolve('ask1')).toBe(false)
  })

  test('forgets questions nobody is waiting on any more', async () => {
    // The broker resolves a timed-out ask on its own and tells the inbox nothing. Without
    // pruning, the console would keep offering questions whose asker has already given up --
    // worse than showing none, because answering one looks like it did something.
    const inbox = new ConsoleInbox('emma')
    await inbox.send('nick', 'old')
    expect(inbox.prune(60_000, Date.now() + 120_000)).toBe(1)
    expect(inbox.list()).toEqual([])
  })
})
