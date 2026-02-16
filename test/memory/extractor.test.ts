import { describe, expect, test } from 'bun:test'
import { extractLessonsFromTask, extractMemories } from '../../src/memory/extractor'
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

describe('extractMemories', () => {
  test('returns empty for insufficient messages', async () => {
    const provider = mockProvider('[]')
    const messages = [{ role: 'user' as const, content: 'hello' }]

    const results = await extractMemories(messages, provider, { minMessages: 2 })
    expect(results.length).toBe(0)
  })

  test('returns empty when conversation is mostly tool calls', async () => {
    const provider = mockProvider('[]')
    const messages = [
      { role: 'user' as const, content: 'do something' },
      { role: 'user' as const, content: 'do more' },
      { role: 'tool' as const, content: 'result 1', tool_call_id: '1' },
      { role: 'tool' as const, content: 'result 2', tool_call_id: '2' },
      { role: 'tool' as const, content: 'result 3', tool_call_id: '3' },
      { role: 'tool' as const, content: 'result 4', tool_call_id: '4' },
      { role: 'tool' as const, content: 'result 5', tool_call_id: '5' },
      { role: 'tool' as const, content: 'result 6', tool_call_id: '6' },
    ]

    const results = await extractMemories(messages, provider, { minMessages: 1 })
    expect(results.length).toBe(0)
  })

  test('parses valid extraction JSON', async () => {
    const provider = mockProvider(
      JSON.stringify([
        {
          key: 'preferred_language',
          value: 'User prefers TypeScript over JavaScript',
          category: 'preference',
        },
        { key: 'project_name', value: 'The project is called egirl', category: 'fact' },
      ]),
    )

    const messages = [
      {
        role: 'user' as const,
        content: 'I prefer TypeScript over JavaScript for this project called egirl',
      },
      { role: 'assistant' as const, content: 'Got it, I will use TypeScript for egirl' },
      { role: 'user' as const, content: 'Thanks, that sounds good' },
    ]

    const results = await extractMemories(messages, provider, { minMessages: 1 })
    expect(results.length).toBe(2)
    expect(results[0]?.key).toBe('preferred_language')
    expect(results[0]?.category).toBe('preference')
    expect(results[1]?.key).toBe('project_name')
    expect(results[1]?.category).toBe('fact')
  })

  test('handles JSON in markdown code blocks', async () => {
    const provider = mockProvider(
      '```json\n[{"key": "api_choice", "value": "Using REST over GraphQL", "category": "decision"}]\n```',
    )

    const messages = [
      { role: 'user' as const, content: 'Let us use REST instead of GraphQL' },
      { role: 'assistant' as const, content: 'Sounds good, REST it is' },
      { role: 'user' as const, content: 'Perfect' },
    ]

    const results = await extractMemories(messages, provider, { minMessages: 1 })
    expect(results.length).toBe(1)
    expect(results[0]?.key).toBe('api_choice')
    expect(results[0]?.category).toBe('decision')
  })

  test('respects maxExtractions limit', async () => {
    const provider = mockProvider(
      JSON.stringify([
        { key: 'a', value: 'value a', category: 'fact' },
        { key: 'b', value: 'value b', category: 'fact' },
        { key: 'c', value: 'value c', category: 'fact' },
      ]),
    )

    const messages = [
      { role: 'user' as const, content: 'lots of facts' },
      { role: 'assistant' as const, content: 'noted' },
      { role: 'user' as const, content: 'more info' },
    ]

    const results = await extractMemories(messages, provider, { minMessages: 1, maxExtractions: 2 })
    expect(results.length).toBe(2)
  })

  test('filters out invalid categories', async () => {
    const provider = mockProvider(
      JSON.stringify([
        { key: 'valid', value: 'valid fact', category: 'fact' },
        { key: 'invalid', value: 'invalid cat', category: 'banana' },
      ]),
    )

    const messages = [
      {
        role: 'user' as const,
        content: 'I need to set up the database with PostgreSQL for the new project',
      },
      {
        role: 'assistant' as const,
        content: 'I will configure PostgreSQL for the project database setup',
      },
      {
        role: 'user' as const,
        content: 'Make sure to use connection pooling with pgbouncer as well',
      },
    ]

    const results = await extractMemories(messages, provider, { minMessages: 1 })
    expect(results.length).toBe(1)
    expect(results[0]?.key).toBe('valid')
  })

  test('sanitizes keys to snake_case', async () => {
    const provider = mockProvider(
      JSON.stringify([{ key: 'My Key With Spaces!', value: 'test', category: 'fact' }]),
    )

    const messages = [
      {
        role: 'user' as const,
        content:
          'The deployment target is running on Kubernetes with helm charts for orchestration',
      },
      {
        role: 'assistant' as const,
        content: 'I understand, Kubernetes with helm for deployment orchestration',
      },
      {
        role: 'user' as const,
        content: 'Yes, and we should use ArgoCD for GitOps continuous delivery',
      },
    ]

    const results = await extractMemories(messages, provider, { minMessages: 1 })
    expect(results.length).toBe(1)
    expect(results[0]?.key).toBe('my_key_with_spaces')
  })

  test('returns empty for LLM errors', async () => {
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        throw new Error('connection refused')
      },
    }

    const messages = [
      {
        role: 'user' as const,
        content: 'Can you help me set up the CI/CD pipeline for the backend service?',
      },
      {
        role: 'assistant' as const,
        content: 'Sure, I will configure the CI/CD pipeline for the backend',
      },
      { role: 'user' as const, content: 'Use GitHub Actions with the existing workflow template' },
    ]

    const results = await extractMemories(messages, provider, { minMessages: 1 })
    expect(results.length).toBe(0)
  })

  test('returns empty for non-JSON LLM output', async () => {
    const provider = mockProvider('I could not extract any memories from this conversation.')

    const messages = [
      {
        role: 'user' as const,
        content: 'We should migrate the authentication system from session tokens to JWTs',
      },
      {
        role: 'assistant' as const,
        content: 'That sounds like a good plan for the auth migration',
      },
      {
        role: 'user' as const,
        content: 'Yes, and make sure we keep backwards compatibility for a month',
      },
    ]

    const results = await extractMemories(messages, provider, { minMessages: 1 })
    expect(results.length).toBe(0)
  })

  test('handles empty array response', async () => {
    const provider = mockProvider('[]')

    const messages = [
      {
        role: 'user' as const,
        content: 'I was thinking about refactoring the routing layer to use a trie structure',
      },
      {
        role: 'assistant' as const,
        content: 'A trie-based router would give better performance for path matching',
      },
      { role: 'user' as const, content: 'Right, especially with the number of routes we have now' },
    ]

    const results = await extractMemories(messages, provider, { minMessages: 1 })
    expect(results.length).toBe(0)
  })

  test('accepts lesson category', async () => {
    const provider = mockProvider(
      JSON.stringify([
        {
          key: 'ci_timeout_fix',
          value: 'CI jobs need a 10-minute timeout — default 5 minutes is too short for integration tests',
          category: 'lesson',
        },
      ]),
    )

    const messages = [
      { role: 'user' as const, content: 'The CI keeps timing out on integration tests' },
      { role: 'assistant' as const, content: 'I increased the timeout from 5 to 10 minutes and it passed' },
      { role: 'user' as const, content: 'Great, that fixed it' },
    ]

    const results = await extractMemories(messages, provider, { minMessages: 1 })
    expect(results.length).toBe(1)
    expect(results[0]?.category).toBe('lesson')
    expect(results[0]?.key).toBe('ci_timeout_fix')
  })

  test('accepts structured decisions with rationale', async () => {
    const provider = mockProvider(
      JSON.stringify([
        {
          key: 'chose_postgres_over_mysql',
          value: 'Chose PostgreSQL over MySQL for the new service. Rationale: better JSON support, JSONB indexing, and the team has more experience with it',
          category: 'decision',
        },
      ]),
    )

    const messages = [
      { role: 'user' as const, content: 'Should we use PostgreSQL or MySQL for the new service?' },
      { role: 'assistant' as const, content: 'PostgreSQL is better here — JSONB support and team familiarity' },
      { role: 'user' as const, content: 'Agreed, let us go with Postgres' },
    ]

    const results = await extractMemories(messages, provider, { minMessages: 1 })
    expect(results.length).toBe(1)
    expect(results[0]?.category).toBe('decision')
    expect(results[0]?.value).toContain('Rationale')
  })
})

describe('extractLessonsFromTask', () => {
  test('extracts lessons from task execution', async () => {
    const provider = mockProvider(
      JSON.stringify([
        {
          key: 'deploy_needs_tracking',
          value: 'Always include tracking numbers in shipping delay responses — saves a follow-up',
          category: 'lesson',
        },
      ]),
    )

    const results = await extractLessonsFromTask(
      'reply-to-client',
      'Reply to client about shipping delay',
      'Replied to client with FedEx tracking update. Client responded positively.',
      false,
      provider,
    )

    expect(results.length).toBe(1)
    expect(results[0]?.category).toBe('lesson')
    expect(results[0]?.key).toBe('deploy_needs_tracking')
  })

  test('returns empty for short results', async () => {
    const provider = mockProvider('[]')
    const results = await extractLessonsFromTask(
      'simple-task',
      'Do something',
      'Done.',
      false,
      provider,
    )
    expect(results.length).toBe(0)
  })

  test('returns empty on provider error', async () => {
    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        throw new Error('connection refused')
      },
    }

    const results = await extractLessonsFromTask(
      'failing-task',
      'Do something complex',
      'This is a long enough result to trigger extraction but the provider will fail on us unfortunately',
      true,
      provider,
    )
    expect(results.length).toBe(0)
  })

  test('caps at 3 lessons max', async () => {
    const provider = mockProvider(
      JSON.stringify([
        { key: 'a', value: 'lesson a', category: 'lesson' },
        { key: 'b', value: 'lesson b', category: 'lesson' },
        { key: 'c', value: 'lesson c', category: 'lesson' },
        { key: 'd', value: 'lesson d', category: 'lesson' },
        { key: 'e', value: 'lesson e', category: 'lesson' },
      ]),
    )

    const results = await extractLessonsFromTask(
      'big-task',
      'Do many things',
      'Completed many operations with several interesting outcomes that we should remember for next time',
      false,
      provider,
    )
    expect(results.length).toBe(3)
  })
})
