/**
 * The Matrix channel's inbound filter and its shutdown path, against a fake API.
 *
 * Everything the transport decides -- who may talk, which events are messages, what a reply
 * from Element actually said -- happens before the agent sees a word, so that is what is
 * tested. The HTTP layer is a stand-in that records what it was asked to send.
 */

import { describe, expect, test } from 'bun:test'
import type { AgentLoop } from '../../src/agent'
import {
  extractText,
  MatrixChannel,
  MatrixOutbound,
  stripReplyFallback,
} from '../../src/channels/matrix'
import type { MatrixApi, MatrixEvent } from '../../src/channels/matrix/api'
import { createReplyBroker } from '../../src/report/broker'

function fakeApi() {
  const sent: Array<{ roomId: string; body: string }> = []
  const calls: string[] = []
  const api: MatrixApi = {
    homeserver: 'https://hs.test',
    async login() {
      calls.push('login')
      return { userId: '@egirl:hs.test', accessToken: 'tok' }
    },
    async logout() {
      calls.push('logout')
    },
    async whoami() {
      calls.push('whoami')
      return '@egirl:hs.test'
    },
    // First call is the initial sync; later calls long-poll until the channel aborts them.
    async sync(since, _timeout, signal) {
      calls.push('sync')
      if (!since) return { next_batch: 's1' }
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
    async join(roomId) {
      calls.push(`join:${roomId}`)
    },
    async sendText(roomId, body) {
      sent.push({ roomId, body })
    },
    async setTyping() {},
  }
  return { api, sent, calls }
}

function fakeAgent(reply = 'hi back') {
  const prompts: string[] = []
  const agent = {
    async run(prompt: string) {
      prompts.push(prompt)
      return { content: reply, provider: 'local' }
    },
  } as unknown as AgentLoop
  return { agent, prompts }
}

function textEvent(sender: string, body: string, extra: Record<string, unknown> = {}): MatrixEvent {
  return { type: 'm.room.message', sender, content: { msgtype: 'm.text', body, ...extra } }
}

function channelWith(
  overrides: Partial<ConstructorParameters<typeof MatrixChannel>[1]> = {},
  agentReply?: string,
) {
  const { api, sent, calls } = fakeApi()
  const { agent, prompts } = fakeAgent(agentReply)
  const broker = createReplyBroker()
  const channel = new MatrixChannel(
    agent,
    {
      homeserver: 'https://hs.test',
      accessToken: 'tok',
      allowedUsers: ['@boss:hs.test'],
      allowedRooms: [],
      autoJoin: true,
      ...overrides,
    },
    broker,
    api,
  )
  return { channel, api, sent, calls, prompts, broker }
}

describe('stripReplyFallback', () => {
  test('drops the quoted fallback Element prepends to replies', () => {
    expect(stripReplyFallback('> <@boss:hs.test> earlier\n> more\n\nactual answer')).toBe(
      'actual answer',
    )
  })

  test('leaves bodies without a fallback alone', () => {
    expect(stripReplyFallback('plain')).toBe('plain')
  })
})

describe('extractText', () => {
  test('ignores edits so a corrected message is not answered twice', () => {
    const edit = textEvent('@boss:hs.test', ' * fixed', {
      'm.relates_to': { rel_type: 'm.replace', event_id: '$x' },
      'm.new_content': { msgtype: 'm.text', body: 'fixed' },
    })
    expect(extractText(edit)).toBeUndefined()
  })

  test('ignores non-text events', () => {
    expect(extractText({ type: 'm.room.member', content: { membership: 'join' } })).toBeUndefined()
    expect(
      extractText({ type: 'm.room.message', content: { msgtype: 'm.image', body: 'cat.png' } }),
    ).toBeUndefined()
  })
})

describe('MatrixChannel.handleEvent', () => {
  test('answers an allowed user in their room', async () => {
    const { channel, sent, prompts } = channelWith()
    await channel.start()
    await channel.handleEvent('!room:hs.test', textEvent('@boss:hs.test', 'hello'))
    await channel.stop()
    expect(prompts).toEqual(['hello'])
    expect(sent).toEqual([{ roomId: '!room:hs.test', body: 'hi back' }])
  })

  test('ignores strangers and its own messages', async () => {
    const { channel, prompts } = channelWith()
    await channel.start()
    await channel.handleEvent('!room:hs.test', textEvent('@rando:hs.test', 'hey'))
    await channel.handleEvent('!room:hs.test', textEvent('@egirl:hs.test', 'hi back'))
    await channel.stop()
    expect(prompts).toEqual([])
  })

  test('honours allowed_rooms', async () => {
    const { channel, prompts } = channelWith({ allowedRooms: ['!ok:hs.test'] })
    await channel.start()
    await channel.handleEvent('!other:hs.test', textEvent('@boss:hs.test', 'psst'))
    await channel.handleEvent('!ok:hs.test', textEvent('@boss:hs.test', 'hello'))
    await channel.stop()
    expect(prompts).toEqual(['hello'])
  })

  test('hands a message to a pending report ask instead of the agent', async () => {
    const { channel, prompts, broker } = channelWith()
    await channel.start()
    const reply = broker.awaitReply('matrix', '!room:hs.test', 1000)
    await channel.handleEvent('!room:hs.test', textEvent('@boss:hs.test', 'ship it'))
    await channel.stop()
    expect(await reply).toBe('ship it')
    expect(prompts).toEqual([])
  })

  test('splits long replies across several events', async () => {
    const { channel, sent } = channelWith({}, 'x'.repeat(9000))
    await channel.start()
    await channel.handleEvent('!room:hs.test', textEvent('@boss:hs.test', 'go'))
    await channel.stop()
    expect(sent.length).toBe(3)
    expect(sent.every((m) => m.body.length <= 4000)).toBe(true)
  })

  test('sends self-targeted notifications to the last room it heard from', async () => {
    const { channel, sent } = channelWith()
    await channel.start()
    await channel.handleEvent('!room:hs.test', textEvent('@boss:hs.test', 'hello'))
    await channel.send('self', 'task done')
    await channel.stop()
    expect(sent.at(-1)).toEqual({ roomId: '!room:hs.test', body: 'task done' })
  })
})

describe('MatrixChannel lifecycle', () => {
  test('uses whoami with an access token and does not log out on stop', async () => {
    const { channel, calls } = channelWith()
    await channel.start()
    await channel.stop()
    expect(calls).toContain('whoami')
    expect(calls).not.toContain('login')
    expect(calls).not.toContain('logout')
  })

  test('logs in with a password and logs the device out on stop', async () => {
    const { channel, calls } = channelWith({
      accessToken: undefined,
      username: 'egirl',
      password: 'pw',
    })
    await channel.start()
    await channel.stop()
    expect(calls).toContain('login')
    expect(calls).toContain('logout')
  })

  test('stop is safe on a channel that never started', async () => {
    const { channel, calls } = channelWith()
    await channel.stop()
    expect(calls).toEqual([])
  })
})

describe('MatrixOutbound', () => {
  // The api process has no sync loop, so nothing here ever calls sync or whoami: a token
  // needs no round-trip at all, and a password logs in once, on the first send.
  const base = {
    homeserver: 'https://hs.test',
    allowedUsers: [],
    allowedRooms: [],
    autoJoin: false,
  }

  test('with a token, sends without any auth round-trip', async () => {
    const { api, sent, calls } = fakeApi()
    const out = new MatrixOutbound({ ...base, accessToken: 'tok' }, api)
    await out.send('!room:hs.test', 'task finished')
    expect(sent).toEqual([{ roomId: '!room:hs.test', body: 'task finished' }])
    expect(calls).toEqual([])
    await out.stop()
    expect(calls).toEqual([])
  })

  test('with a password, logs in on first send only and logs the device out on stop', async () => {
    const { api, sent, calls } = fakeApi()
    const out = new MatrixOutbound({ ...base, username: 'egirl', password: 'pw' }, api)
    await out.send('!room:hs.test', 'one')
    await out.send('!room:hs.test', 'two')
    expect(sent.map((s) => s.body)).toEqual(['one', 'two'])
    expect(calls).toEqual(['login'])
    await out.stop()
    expect(calls).toEqual(['login', 'logout'])
  })

  test('self resolves to the first allowed room; nothing to fall back to is a no-op', async () => {
    const { api, sent } = fakeApi()
    const out = new MatrixOutbound(
      { ...base, accessToken: 'tok', allowedRooms: ['!a:hs.test'] },
      api,
    )
    await out.send('self', 'hi')
    expect(sent).toEqual([{ roomId: '!a:hs.test', body: 'hi' }])
    const none = new MatrixOutbound({ ...base, accessToken: 'tok' }, api)
    await none.send('self', 'lost')
    expect(sent).toHaveLength(1)
  })

  test('a failed login is retried on the next send', async () => {
    const { api, sent, calls } = fakeApi()
    let fail = true
    api.login = async () => {
      calls.push('login')
      if (fail) throw new Error('homeserver down')
      return { userId: '@egirl:hs.test', accessToken: 'tok' }
    }
    const out = new MatrixOutbound({ ...base, username: 'egirl', password: 'pw' }, api)
    await expect(out.send('!r:hs.test', 'x')).rejects.toThrow('homeserver down')
    fail = false
    await out.send('!r:hs.test', 'y')
    expect(calls).toEqual(['login', 'login'])
    expect(sent.map((s) => s.body)).toEqual(['y'])
  })
})
