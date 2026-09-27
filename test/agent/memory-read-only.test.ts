import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import type { MemoryManager } from '../../src/memory'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

// Long enough to clear the extractor's minimum condensed length.
const MESSAGE = 'my cat is named Miso, she is a grey tabby and she hates the vacuum'

function setup(isMemoryReadOnly: boolean) {
  let extractionRequested!: () => void
  const extractionSeen = new Promise<void>((resolve) => {
    extractionRequested = resolve
  })
  const calls = { extraction: 0 }
  const provider: LLMProvider = {
    name: 'stub',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const first = req.messages[0]
      if (typeof first?.content === 'string' && first.content.includes('memory extraction')) {
        calls.extraction++
        extractionRequested()
        return stubResponse({
          content: '[{"key":"cat_name","value":"The cat is Miso","category":"fact"}]',
        })
      }
      return stubResponse({ content: 'noted' })
    },
  }
  const writes: string[] = []
  const memory = {
    checkDuplicate: async () => undefined,
    set: async (key: string) => {
      writes.push(key)
    },
  } as unknown as MemoryManager

  const config = makeConfig(makeWorkspace())
  config.memory = { ...config.memory, autoExtract: true, extractionMinMessages: 1 }
  const agent = new AgentLoop({
    config,
    toolExecutor: makeExecutorWithNoop(),
    localProvider: provider,
    sessionId: 'openai:ro',
    memory,
    isMemoryReadOnly,
  })
  return { agent, writes, extractionSeen, calls }
}

describe('read-only memory', () => {
  test('a normal loop learns from its turn', async () => {
    const { agent, writes, extractionSeen } = setup(false)
    await agent.run(MESSAGE)
    await extractionSeen
    await Bun.sleep(10)
    expect(writes).toEqual(['auto/cat_name'])
  })

  test('a read-only loop never extracts', async () => {
    const { agent, writes, calls } = setup(true)
    await agent.run(MESSAGE)
    // Extraction is kicked off synchronously at the end of run(), so a request would already
    // be in flight here; the sleep only gives a stray write time to land.
    await Bun.sleep(20)
    expect(calls.extraction).toBe(0)
    expect(writes).toEqual([])
  })
})
