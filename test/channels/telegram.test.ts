/**
 * The Telegram channel against a fake Bot API.
 *
 * The transport is four JSON calls (getMe, getUpdates, sendMessage, and abort on stop), so the
 * fake is the whole boundary: it records every call and plays back scripted updates.
 */

import { describe, expect, test } from 'bun:test'
import type { AgentLoop } from '../../src/agent'
import {
  chunkText,
  type FetchLike,
  isAllowedTelegramUser,
  TelegramChannel,
  type TelegramUpdate,
} from '../../src/channels/telegram'

interface Call {
  method: string
  body: Record<string, unknown>
}

function fakeApi(updates: TelegramUpdate[]) {
  const calls: Call[] = []
  let served = false
  const fetchFn: FetchLike = async (input, init) => {
    const method = input.split('/').pop() ?? ''
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ method, body })

    const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }))
    if (method === 'getMe') return reply({ id: 1, username: 'egirl_bot', is_bot: true })
    if (method === 'sendMessage') return reply({ message_id: 1 })
    if (method === 'getUpdates') {
      if (!served) {
        served = true
        return reply(updates)
      }
      // Long poll: hang until stop() aborts, like the real server holding the request open.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    return new Response(JSON.stringify({ ok: false, description: `unknown ${method}` }))
  }
  return { calls, fetchFn }
}

function fakeAgent(content: string): { agent: AgentLoop; prompts: string[] } {
  const prompts: string[] = []
  const agent = {
    async run(message: string) {
      prompts.push(message)
      return { content, provider: 'local' }
    },
  } as unknown as AgentLoop
  return { agent, prompts }
}

function textUpdate(id: number, from: { id: number; username?: string }, text: string) {
  return {
    update_id: id,
    message: { message_id: id, from, chat: { id: from.id, type: 'private' }, text },
  }
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('isAllowedTelegramUser', () => {
  test('empty allow-list admits everyone', () => {
    expect(isAllowedTelegramUser([], { id: 42 })).toBe(true)
  })

  test('matches numeric IDs and usernames, with or without @', () => {
    expect(isAllowedTelegramUser(['42'], { id: 42 })).toBe(true)
    expect(isAllowedTelegramUser(['@Nick'], { id: 7, username: 'nick' })).toBe(true)
    expect(isAllowedTelegramUser(['nick'], { id: 7, username: 'Nick' })).toBe(true)
    expect(isAllowedTelegramUser(['42'], { id: 7, username: 'nick' })).toBe(false)
  })
})

describe('chunkText', () => {
  test('leaves short text alone', () => {
    expect(chunkText('hi', 10)).toEqual(['hi'])
  })

  test('splits on newlines under the limit and never exceeds it', () => {
    const chunks = chunkText('aaaa\nbbbb\ncccc', 10)
    expect(chunks).toEqual(['aaaa\nbbbb', 'cccc'])
    const hard = chunkText('x'.repeat(25), 10)
    expect(hard).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx'])
  })
})

describe('TelegramChannel', () => {
  test('replies to an allowed user and ignores the rest', async () => {
    const { calls, fetchFn } = fakeApi([
      textUpdate(10, { id: 999, username: 'stranger' }, 'hello?'),
      textUpdate(11, { id: 42, username: 'nick' }, 'ping'),
    ])
    const { agent, prompts } = fakeAgent('pong')
    const channel = new TelegramChannel(
      agent,
      { token: 't', allowedUsers: ['42'] },
      undefined,
      fetchFn,
    )

    await channel.start()
    await until(() => calls.some((c) => c.method === 'sendMessage'))
    await channel.stop()

    expect(prompts).toEqual(['ping'])
    const sent = calls.filter((c) => c.method === 'sendMessage')
    expect(sent).toEqual([{ method: 'sendMessage', body: { chat_id: '42', text: 'pong' } }])
    // Both updates were acknowledged, so a restart does not replay the stranger's message.
    const polls = calls.filter((c) => c.method === 'getUpdates')
    expect(polls[1]?.body.offset).toBe(12)
  })

  test('"self" notifications go to the last chat that spoke, or a numeric allow-list entry', async () => {
    const { calls, fetchFn } = fakeApi([])
    const channel = new TelegramChannel(
      fakeAgent('').agent,
      { token: 't', allowedUsers: ['@nick', '42'] },
      undefined,
      fetchFn,
    )
    await channel.sendTo('self', 'task done')
    expect(calls.at(-1)?.body).toEqual({ chat_id: '42', text: 'task done' })
  })

  test('long replies are split into Telegram-sized messages', async () => {
    const { calls, fetchFn } = fakeApi([])
    const channel = new TelegramChannel(
      fakeAgent('').agent,
      { token: 't', allowedUsers: [] },
      undefined,
      fetchFn,
    )
    await channel.sendTo('1', 'x'.repeat(5000))
    const sent = calls.filter((c) => c.method === 'sendMessage')
    expect(sent.length).toBe(2)
    expect(String(sent[0]?.body.text).length).toBe(4096)
  })
})
