import { describe, expect, test } from 'bun:test'
import { ReplyBroker } from '../../src/report/broker'

describe('ReplyBroker', () => {
  test('delivers an inbound message to a pending ask', async () => {
    const broker = new ReplyBroker()
    const reply = broker.awaitReply('xmpp', 'boss@example.com', 5000)
    expect(broker.hasPending('xmpp', 'boss@example.com')).toBe(true)
    expect(broker.tryDeliver('xmpp', 'boss@example.com', 'use the DX9 build')).toBe(true)
    expect(await reply).toBe('use the DX9 build')
    expect(broker.hasPending('xmpp', 'boss@example.com')).toBe(false)
  })

  test('matches targets case-insensitively', async () => {
    const broker = new ReplyBroker()
    const reply = broker.awaitReply('xmpp', 'Boss@Example.com', 5000)
    expect(broker.tryDeliver('xmpp', 'boss@example.com', 'yes')).toBe(true)
    expect(await reply).toBe('yes')
  })

  test('does not consume messages with nothing pending', () => {
    const broker = new ReplyBroker()
    expect(broker.tryDeliver('xmpp', 'boss@example.com', 'hello')).toBe(false)
  })

  test('does not consume messages from a different target or channel', async () => {
    const broker = new ReplyBroker()
    const reply = broker.awaitReply('xmpp', 'boss@example.com', 50)
    expect(broker.tryDeliver('xmpp', 'other@example.com', 'nope')).toBe(false)
    expect(broker.tryDeliver('discord', 'boss@example.com', 'nope')).toBe(false)
    expect(await reply).toBeUndefined()
  })

  test('multiple asks on one target resolve FIFO', async () => {
    const broker = new ReplyBroker()
    const first = broker.awaitReply('discord', '123', 5000)
    const second = broker.awaitReply('discord', '123', 5000)
    broker.tryDeliver('discord', '123', 'answer one')
    broker.tryDeliver('discord', '123', 'answer two')
    expect(await first).toBe('answer one')
    expect(await second).toBe('answer two')
  })

  test('times out to undefined and clears the pending slot', async () => {
    const broker = new ReplyBroker()
    const reply = broker.awaitReply('xmpp', 'boss@example.com', 20)
    expect(await reply).toBeUndefined()
    expect(broker.hasPending('xmpp', 'boss@example.com')).toBe(false)
    // A late reply is not consumed.
    expect(broker.tryDeliver('xmpp', 'boss@example.com', 'too late')).toBe(false)
  })
})
