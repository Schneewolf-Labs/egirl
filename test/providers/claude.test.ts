import { describe, expect, test } from 'bun:test'
import { type ClaudeQueryFn, createClaudeProvider, toPrompt } from '../../src/providers/claude'

type Call = { prompt: unknown; options: Record<string, unknown> }

function fakeQuery(result: Record<string, unknown>): { fn: ClaudeQueryFn; calls: Call[] } {
  const calls: Call[] = []
  const fn = ((args: Call) => {
    calls.push(args)
    return (async function* () {
      yield { type: 'system', subtype: 'init' }
      yield { type: 'result', usage: { input_tokens: 12, output_tokens: 3 }, ...result }
    })()
  }) as unknown as ClaudeQueryFn
  return { fn, calls }
}

describe('createClaudeProvider', () => {
  test('one query with no tools, no settings and the named model; the result is the reply', async () => {
    const { fn, calls } = fakeQuery({ subtype: 'success', result: '{"ok":true}' })
    const provider = createClaudeProvider('haiku', fn)
    const reply = await provider.chat({
      messages: [
        { role: 'system', content: 'JSON only.' },
        { role: 'user', content: 'Extract.' },
      ],
    })
    expect(reply).toEqual({
      content: '{"ok":true}',
      usage: { input_tokens: 12, output_tokens: 3 },
      model: 'haiku',
    })
    const [call] = calls
    expect(call?.prompt).toBe('Extract.')
    expect(call?.options).toMatchObject({
      model: 'haiku',
      systemPrompt: 'JSON only.',
      tools: [],
      settingSources: [],
      mcpServers: {},
      maxTurns: 1,
      persistSession: false,
    })
  })

  test('a failed query throws instead of returning an empty reply', async () => {
    const { fn } = fakeQuery({ subtype: 'error_during_execution' })
    const provider = createClaudeProvider('haiku', fn)
    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      'error_during_execution',
    )
  })
})

describe('toPrompt', () => {
  test('a longer exchange is written out turn by turn, tool calls and results included', () => {
    const { system, prompt } = toPrompt([
      { role: 'system', content: 'Summarize.' },
      { role: 'user', content: 'Fix the build' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: '1', name: 'execute_command', arguments: { command: 'make' } }],
      },
      { role: 'tool', content: 'ok', tool_call_id: '1' },
    ])
    expect(system).toBe('Summarize.')
    expect(prompt).toBe(
      'User: Fix the build\n\nAssistant: [called execute_command({"command":"make"})]\n\n[tool result]\nok',
    )
  })
})
