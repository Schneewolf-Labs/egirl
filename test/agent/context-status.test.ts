import { describe, expect, test } from 'bun:test'
import { IMAGE_TOKENS } from '../../src/agent/context-window'
import { computeContextStatus } from '../../src/agent/status'

const tokenizer = { countTokens: async (t: string) => Math.ceil(t.length / 4) }
const config = { local: { contextLength: 32768 } } as Parameters<typeof computeContextStatus>[0]

describe('computeContextStatus', () => {
  test('an attached image counts as an image, not as its base64', async () => {
    const image = `data:image/png;base64,${'A'.repeat(2_000_000)}`
    const context = {
      systemPrompt: 'You are Niku.',
      sessionId: 'stage:niku',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look at it.' },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
        { role: 'assistant', content: 'A cat with a tiny hat!' },
      ],
    } as unknown as Parameters<typeof computeContextStatus>[2]
    const s = await computeContextStatus(config, tokenizer, context)
    expect(s.messageTokens).toBeGreaterThan(IMAGE_TOKENS)
    expect(s.messageTokens).toBeLessThan(IMAGE_TOKENS + 100)
    expect(s.utilization).toBeLessThan(0.1)
  })
})
