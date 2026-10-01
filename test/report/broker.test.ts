import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('ReplyBroker across processes (shared asks.db)', () => {
  // serve hears chat; api runs tasks. Two brokers on one file stand in for the two processes.
  const pair = () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'egirl-asks-')), 'asks.db')
    return [
      new ReplyBroker({ dbPath, pollMs: 10 }),
      new ReplyBroker({ dbPath, pollMs: 10 }),
    ] as const
  }

  test('a reply heard by one process answers an ask parked in the other', async () => {
    const [api, serve] = pair()
    const reply = api.awaitReply('matrix', '!room:example.com', 5000)
    expect(serve.hasPending('matrix', '!room:example.com')).toBe(true)
    // serve's channel offers the inbound message to its broker: consumed, so no new turn starts.
    expect(serve.tryDeliver('matrix', '!room:example.com', 'keep #98, close #45')).toBe(true)
    expect(await reply).toBe('keep #98, close #45')
    expect(serve.hasPending('matrix', '!room:example.com')).toBe(false)
  })

  test('with nothing pending anywhere, a message is not consumed', () => {
    const [, serve] = pair()
    expect(serve.tryDeliver('matrix', '!room:example.com', 'hello')).toBe(false)
  })

  test('asks from both processes are answered oldest first', async () => {
    const [api, serve] = pair()
    const first = api.awaitReply('matrix', 'room', 5000)
    await Bun.sleep(2)
    const second = serve.awaitReply('matrix', 'room', 5000)
    expect(serve.tryDeliver('matrix', 'room', 'one')).toBe(true)
    expect(serve.tryDeliver('matrix', 'room', 'two')).toBe(true)
    expect(await first).toBe('one')
    expect(await second).toBe('two')
  })

  test('a timed-out ask leaves nothing behind for a late reply to land on', async () => {
    const [api, serve] = pair()
    expect(await api.awaitReply('matrix', 'room', 20)).toBeUndefined()
    expect(serve.hasPending('matrix', 'room')).toBe(false)
    expect(serve.tryDeliver('matrix', 'room', 'too late')).toBe(false)
  })
})
