import { describe, expect, test } from 'bun:test'
import { flushBeforeCompaction } from '../../src/memory/compaction-flush'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'

function mockProvider(responseContent: string): LLMProvider {
  return {
    name: 'mock',
    async chat(_req: ChatRequest): Promise<ChatResponse> {
      return {
        content: responseContent,
        usage: { input_tokens: 0, output_tokens: 0 },
        model: 'mock',
      }
    },
  }
}

describe('flushBeforeCompaction', () => {
  test('returns empty for no messages', async () => {
    const provider = mockProvider('[]')
    const results = await flushBeforeCompaction([], provider)
    expect(results.length).toBe(0)
  })

  test('extracts facts from dropped conversation', async () => {
    const provider = mockProvider(
      JSON.stringify([
        {
          key: 'task_auth_migration_status',
          value:
            'Migrating auth from sessions to JWT. Backend endpoints updated, frontend pending.',
          category: 'project',
        },
        {
          key: 'error_redis_timeout',
          value:
            'Redis connection timeout at redis://prod:6379 — increased timeout to 5000ms as workaround.',
          category: 'fact',
        },
      ]),
    )

    const messages = [
      { role: 'user' as const, content: 'Migrate the auth system from sessions to JWT' },
      {
        role: 'assistant' as const,
        content: 'I will update the backend endpoints first.',
        tool_calls: [{ id: '1', name: 'file_edit', arguments: { path: 'src/auth.ts' } }],
      },
      { role: 'tool' as const, content: 'File updated successfully', tool_call_id: '1' },
      { role: 'user' as const, content: 'Good. I hit a Redis timeout at redis://prod:6379' },
      {
        role: 'assistant' as const,
        content: 'Increased the timeout to 5000ms as a workaround. Frontend migration is next.',
      },
    ]

    const results = await flushBeforeCompaction(messages, provider)
    expect(results.length).toBe(2)
    expect(results[0]?.key).toBe('task_auth_migration_status')
    expect(results[0]?.category).toBe('project')
    expect(results[1]?.key).toBe('error_redis_timeout')
    expect(results[1]?.category).toBe('fact')
  })

  test('handles JSON in markdown code blocks', async () => {
    const provider = mockProvider(
      '```json\n[{"key": "deploy_target", "value": "Deploying to k8s cluster us-east-1", "category": "fact"}]\n```',
    )

    const messages = [
      { role: 'user' as const, content: 'Deploy to the us-east-1 k8s cluster' },
      { role: 'assistant' as const, content: 'Deploying now' },
    ]

    const results = await flushBeforeCompaction(messages, provider)
    expect(results.length).toBe(1)
    expect(results[0]?.key).toBe('deploy_target')
  })

  test('respects maxExtractions limit', async () => {
    const provider = mockProvider(
      JSON.stringify([
        { key: 'a', value: 'value a', category: 'fact' },
        { key: 'b', value: 'value b', category: 'fact' },
        { key: 'c', value: 'value c', category: 'fact' },
        { key: 'd', value: 'value d', category: 'fact' },
      ]),
    )

    const messages = [
      { role: 'user' as const, content: 'lots of context here' },
      { role: 'assistant' as const, content: 'acknowledged' },
    ]

    const results = await flushBeforeCompaction(messages, provider, 2)
    expect(results.length).toBe(2)
  })

  test('filters invalid categories', async () => {
    const provider = mockProvider(
      JSON.stringify([
        { key: 'valid', value: 'valid fact', category: 'decision' },
        { key: 'invalid', value: 'bad category', category: 'banana' },
      ]),
    )

    const messages = [
      { role: 'user' as const, content: 'We decided to use PostgreSQL' },
      { role: 'assistant' as const, content: 'Noted, PostgreSQL it is' },
    ]

    const results = await flushBeforeCompaction(messages, provider)
    expect(results.length).toBe(1)
    expect(results[0]?.key).toBe('valid')
  })

  test('sanitizes keys to snake_case', async () => {
    const provider = mockProvider(
      JSON.stringify([{ key: 'My Key-With.Stuff!', value: 'test', category: 'fact' }]),
    )

    const messages = [
      { role: 'user' as const, content: 'some context' },
      { role: 'assistant' as const, content: 'response' },
    ]

    const results = await flushBeforeCompaction(messages, provider)
    expect(results.length).toBe(1)
    expect(results[0]?.key).toBe('my_key_with_stuff')
  })

  test('returns empty on LLM failure', async () => {
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        throw new Error('connection refused')
      },
    }

    const messages = [
      { role: 'user' as const, content: 'important task context' },
      { role: 'assistant' as const, content: 'working on it' },
    ]

    const results = await flushBeforeCompaction(messages, provider)
    expect(results.length).toBe(0)
  })

  test('returns empty for non-JSON LLM output', async () => {
    const provider = mockProvider('I cannot extract any information from this.')

    const messages = [
      { role: 'user' as const, content: 'do something' },
      { role: 'assistant' as const, content: 'done' },
    ]

    const results = await flushBeforeCompaction(messages, provider)
    expect(results.length).toBe(0)
  })

  test('skips system messages in transcript', async () => {
    let capturedPrompt = ''
    const provider: LLMProvider = {
      name: 'mock',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        capturedPrompt = req.messages[0]?.content as string
        return { content: '[]', usage: { input_tokens: 0, output_tokens: 0 }, model: 'mock' }
      },
    }

    const messages = [
      {
        role: 'system' as const,
        content: '[Conversation summary — earlier messages were compacted]',
      },
      { role: 'user' as const, content: 'user message here' },
      { role: 'assistant' as const, content: 'assistant response' },
    ]

    await flushBeforeCompaction(messages, provider)
    expect(capturedPrompt).not.toContain('Conversation summary')
    expect(capturedPrompt).toContain('user message here')
  })

  test('includes tool results in transcript', async () => {
    let capturedPrompt = ''
    const provider: LLMProvider = {
      name: 'mock',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        capturedPrompt = req.messages[0]?.content as string
        return { content: '[]', usage: { input_tokens: 0, output_tokens: 0 }, model: 'mock' }
      },
    }

    const messages = [
      { role: 'user' as const, content: 'read the config file' },
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 't1', name: 'file_read', arguments: { path: '/etc/config.toml' } }],
      },
      {
        role: 'tool' as const,
        content: 'port = 8080\nhost = "0.0.0.0"',
        tool_call_id: 't1',
      },
    ]

    await flushBeforeCompaction(messages, provider)
    expect(capturedPrompt).toContain('port = 8080')
    expect(capturedPrompt).toContain('Tool result')
  })
})
