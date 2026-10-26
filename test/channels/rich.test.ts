/**
 * Structured cards: the markdown fallback and the send-or-fall-back dispatch.
 *
 * A producer builds one RichCard; a surface with native cards (Discord embeds) shows it as one,
 * and every other surface gets the markdown rendering. These tests pin the fallback text and
 * prove sendCardOrText picks the native path only when the channel offers it.
 */

import { describe, expect, test } from 'bun:test'
import { renderCardText, sendCardOrText } from '../../src/channels/rich'
import type { OutboundChannel, RichCard } from '../../src/channels/types'

describe('renderCardText', () => {
  test('renders title with a status icon, body, fields, url and footer', () => {
    const card: RichCard = {
      title: 'Build finished',
      text: 'All green.',
      status: 'ok',
      fields: [{ name: 'Duration', value: '42s' }],
      url: 'https://ci.example/run/1',
      footer: 'background task',
    }
    expect(renderCardText(card)).toBe(
      '**✅ Build finished**\nAll green.\n**Duration:** 42s\nhttps://ci.example/run/1\n_background task_',
    )
  })

  test('maps each status to its icon', () => {
    expect(renderCardText({ title: 't', status: 'warn' })).toBe('**⚠️ t**')
    expect(renderCardText({ title: 't', status: 'error' })).toBe('**❌ t**')
    expect(renderCardText({ title: 't', status: 'info' })).toBe('**• t**')
  })

  test('a title without a status has no icon', () => {
    expect(renderCardText({ title: 'Plain' })).toBe('**Plain**')
  })

  test('an empty card renders to an empty string', () => {
    expect(renderCardText({})).toBe('')
  })
})

describe('sendCardOrText', () => {
  const card: RichCard = { title: 'Report from Juno', text: 'done', status: 'info' }

  test('falls back to send() with the markdown rendering when the channel has no sendCard', async () => {
    const sent: Array<{ target: string; message: string }> = []
    const channel: OutboundChannel = {
      send: async (target, message) => {
        sent.push({ target, message })
      },
    }
    await sendCardOrText(channel, 'room-1', card)
    expect(sent).toEqual([{ target: 'room-1', message: '**• Report from Juno**\ndone' }])
  })

  test('uses sendCard, not send, when the channel supports it', async () => {
    let sentCard: RichCard | undefined
    let plainCalled = false
    const channel: OutboundChannel = {
      send: async () => {
        plainCalled = true
      },
      sendCard: async (_target, c) => {
        sentCard = c
      },
    }
    await sendCardOrText(channel, 'room-1', card)
    expect(sentCard).toBe(card)
    expect(plainCalled).toBe(false)
  })
})
