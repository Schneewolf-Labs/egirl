import { describe, expect, test } from 'bun:test'
import { chatWithRetry, stripImageContent } from '../../src/agent/chat'
import type { ChatMessage, ChatResponse, LLMProvider } from '../../src/providers/types'

describe('stripImageContent', () => {
  test('replaces data-URL strings and image_url parts, counts them', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'look at this' },
      { role: 'tool', content: 'data:image/png;base64,AAAA', tool_call_id: 'a' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'and this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
        ],
      },
    ]
    const r = stripImageContent(messages)
    expect(r.changed).toBe(true)
    expect(r.count).toBe(2)
    expect(r.messages[1]?.content).toContain('image omitted')
    const parts = r.messages[2]?.content as Array<{ type: string; text?: string }>
    expect(parts[1]?.type).toBe('text')
    expect(parts[1]?.text).toContain('image omitted')
    // originals untouched
    expect(messages[1]?.content).toContain('data:image')
  })

  test('no images → unchanged', () => {
    const r = stripImageContent([{ role: 'user', content: 'plain' }])
    expect(r.changed).toBe(false)
  })
})

describe('chatWithRetry image rejection', () => {
  test('strips images and retries when the endpoint rejects image input', async () => {
    let calls = 0
    let lastMessages: ChatMessage[] = []
    const provider: LLMProvider = {
      name: 'stub',
      async chat({ messages }): Promise<ChatResponse> {
        calls++
        lastMessages = messages
        const hasImage = messages.some(
          (m) => typeof m.content === 'string' && m.content.startsWith('data:image'),
        )
        if (hasImage) {
          throw new Error(
            'llama.cpp error: 500 - {"error":{"message":"image input is not supported - hint: if this is unexpected, you may need to provide the mmproj"}}',
          )
        }
        return {
          content: 'ok',
          provider: 'stub',
          usage: { input_tokens: 1, output_tokens: 1 },
          model: 'stub',
        } as ChatResponse
      },
    }

    const response = await chatWithRetry({
      provider,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'tool', content: 'data:image/png;base64,XYZ', tool_call_id: 'a' },
      ],
      tools: [],
    })
    expect(response.content).toBe('ok')
    expect(calls).toBe(2) // failed once, stripped, succeeded
    expect(String(lastMessages[1]?.content)).toContain('image omitted')
  })
})
