/**
 * Tools on the wire.
 *
 * Tool definitions used to be pasted into the system prompt in a guessed dialect and calls
 * regex-parsed out of raw text; the template never saw a tool. A 9B operator scored 1/8 on the
 * delegation ladder that way against 5/8 with the template rendering the same conversation.
 * Pin the request shape (native `tools`, no `/think` prefix, no client-side markup) and the
 * assembly of streamed `tool_calls` deltas.
 */

import { describe, expect, test } from 'bun:test'
import { LlamaCppProvider } from '../../src/providers/llamacpp'
import type { ChatRequest, ChatResponse } from '../../src/providers/types'

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
]

function sse(chunks: object[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`))
      c.enqueue(enc.encode('data: [DONE]\n\n'))
      c.close()
    },
  })
}

const delta = (d: object, finish_reason: string | null = null) => ({
  choices: [{ delta: d, finish_reason }],
})

async function roundTrip(
  req: Partial<ChatRequest>,
  chunks: object[],
): Promise<{ body: Record<string, unknown>; response: ChatResponse }> {
  const realFetch = globalThis.fetch
  let body: Record<string, unknown> = {}
  // @ts-expect-error test double
  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(sse(chunks), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  try {
    const provider = new LlamaCppProvider('http://stub', 'test')
    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      onToken: () => {},
      ...req,
    })
    return { body, response }
  } finally {
    globalThis.fetch = realFetch
  }
}

describe('tools on the wire', () => {
  test('tool definitions are sent as `tools`, not pasted into the system prompt', async () => {
    const { body } = await roundTrip(
      {
        messages: [
          { role: 'system', content: 'You are egirl.' },
          { role: 'user', content: 'read hosts' },
        ],
        tools: TOOLS,
      },
      [delta({ content: 'ok' })],
    )
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: TOOLS[0]?.parameters,
        },
      },
    ])
    expect(body.parallel_tool_calls).toBe(true)
    const messages = body.messages as Array<{ role: string; content: string }>
    expect(messages[0]?.content).toBe('You are egirl.')
    expect(JSON.stringify(messages)).not.toContain('<tools>')
  })

  test('no tools means no tools field at all', async () => {
    const { body } = await roundTrip({}, [delta({ content: 'ok' })])
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('parallel_tool_calls')
  })

  test('the /think soft switch is never prepended to the user turn', async () => {
    for (const level of ['off', 'medium'] as const) {
      const { body } = await roundTrip({ thinking: { level } }, [delta({ content: 'ok' })])
      const messages = body.messages as Array<{ role: string; content: string }>
      expect(messages[0]?.content).toBe('hi')
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: level !== 'off' })
    }
  })
})

describe('streamed tool calls', () => {
  test('fragments are assembled by index into parsed calls', async () => {
    const { response } = await roundTrip({ tools: TOOLS }, [
      delta({ role: 'assistant', content: null }),
      delta({
        tool_calls: [
          {
            index: 0,
            id: 'abc',
            type: 'function',
            function: { name: 'read_file', arguments: '{' },
          },
        ],
      }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"path":"/etc' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '/hosts"}' } }] }),
      delta({
        tool_calls: [
          { index: 1, id: 'def', type: 'function', function: { name: 'read_file', arguments: '' } },
        ],
      }),
      delta({ tool_calls: [{ index: 1, function: { arguments: '{"path":"/etc/passwd"}' } }] }),
      delta({}, 'tool_calls'),
    ])
    expect(response.tool_calls).toEqual([
      { id: 'abc', name: 'read_file', arguments: { path: '/etc/hosts' } },
      { id: 'def', name: 'read_file', arguments: { path: '/etc/passwd' } },
    ])
    expect(response.content).toBe('')
    expect(response.finish_reason).toBe('tool_calls')
  })

  test('a call the server left as text is still parsed, after the structured ones', async () => {
    const { response } = await roundTrip({ tools: TOOLS }, [
      delta({
        tool_calls: [
          { index: 0, id: 'abc', function: { name: 'read_file', arguments: '{"path":"a"}' } },
        ],
      }),
      delta({
        content: '<tool_call>\n{"name": "read_file", "arguments": {"path": "b"}}\n</tool_call>',
      }),
      delta({}, 'stop'),
    ])
    expect(response.tool_calls?.map((c) => c.arguments.path)).toEqual(['a', 'b'])
    expect(new Set(response.tool_calls?.map((c) => c.id)).size).toBe(2)
    expect(response.content).toBe('')
  })

  test('empty arguments mean a call with no parameters', async () => {
    const { response } = await roundTrip({ tools: TOOLS }, [
      delta({ tool_calls: [{ index: 0, id: 'x', function: { name: 'list_dir', arguments: '' } }] }),
      delta({}, 'tool_calls'),
    ])
    expect(response.tool_calls).toEqual([{ id: 'x', name: 'list_dir', arguments: {} }])
  })

  test('unparseable arguments are handed to the stranded-call recovery as markup', async () => {
    const { response } = await roundTrip({ tools: TOOLS }, [
      delta({
        tool_calls: [
          { index: 0, id: 'x', function: { name: 'read_file', arguments: '{"path": ' } },
        ],
      }),
      delta({}, 'tool_calls'),
    ])
    expect(response.tool_calls).toBeUndefined()
    expect(response.content).toContain('<tool_call>')
    expect(response.content).toContain('read_file')
  })
})
