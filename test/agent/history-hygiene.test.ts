import { describe, expect, test } from 'bun:test'
import { pruneMalformedCallPairs, toolsWithRequiredParams } from '../../src/agent/history-hygiene'
import type { ChatMessage, ToolDefinition } from '../../src/providers/types'

const TOOLS: ToolDefinition[] = [
  {
    name: 'execute_command',
    description: 'run',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'peer_list',
    description: 'list peers',
    parameters: { type: 'object', properties: {}, required: [] },
  },
]

const REQUIRED = toolsWithRequiredParams(TOOLS)

function emptyCall(id: string): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, name: 'execute_command', arguments: {} }],
  }
}

function errorResult(id: string): ChatMessage {
  return { role: 'tool', content: 'Missing required parameter: command', tool_call_id: id }
}

function goodCall(id: string, command: string): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, name: 'execute_command', arguments: { command } }],
  }
}

describe('toolsWithRequiredParams', () => {
  test('collects only tools with required params', () => {
    expect(REQUIRED.has('execute_command')).toBe(true)
    expect(REQUIRED.has('peer_list')).toBe(false)
  })
})

describe('pruneMalformedCallPairs', () => {
  test('drops older empty-args pairs, keeps the most recent one', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      emptyCall('a'),
      errorResult('a'),
      goodCall('b', 'ls'),
      { role: 'tool', content: 'file1\nfile2', tool_call_id: 'b' },
      emptyCall('c'),
      errorResult('c'),
      { role: 'assistant', content: 'hmm' },
      emptyCall('d'),
      errorResult('d'),
    ]
    const out = pruneMalformedCallPairs(messages, REQUIRED)
    // Pairs a and c dropped (4 messages); pair d (most recent) kept.
    expect(out).toHaveLength(6)
    const ids = out.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? [])
    expect(ids).toEqual(['b', 'd'])
    // The kept pair still has its corrective error.
    expect(out.some((m) => m.tool_call_id === 'd')).toBe(true)
  })

  test('a single malformed pair is left alone', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      emptyCall('a'),
      errorResult('a'),
    ]
    expect(pruneMalformedCallPairs(messages, REQUIRED)).toHaveLength(3)
  })

  test('empty-args calls to tools without required params are never pruned', () => {
    const listCall: ChatMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'p1', name: 'peer_list', arguments: {} }],
    }
    const messages: ChatMessage[] = [
      listCall,
      { role: 'tool', content: 'zero — online', tool_call_id: 'p1' },
      { ...listCall, tool_calls: [{ id: 'p2', name: 'peer_list', arguments: {} }] },
      { role: 'tool', content: 'zero — online', tool_call_id: 'p2' },
      emptyCall('a'),
      errorResult('a'),
    ]
    expect(pruneMalformedCallPairs(messages, REQUIRED)).toHaveLength(6)
  })

  test('mixed groups (one good call + one empty) are left alone', () => {
    const mixed: ChatMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'm1', name: 'execute_command', arguments: { command: 'pwd' } },
        { id: 'm2', name: 'execute_command', arguments: {} },
      ],
    }
    const messages: ChatMessage[] = [
      mixed,
      { role: 'tool', content: '/home', tool_call_id: 'm1' },
      { role: 'tool', content: 'Missing required parameter', tool_call_id: 'm2' },
      emptyCall('a'),
      errorResult('a'),
      emptyCall('b'),
      errorResult('b'),
    ]
    const out = pruneMalformedCallPairs(messages, REQUIRED)
    // Mixed group survives; pair a dropped; pair b (most recent) kept.
    expect(out.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? [])).toEqual(['m1', 'm2', 'b'])
  })

  test('plain conversation is untouched', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    expect(pruneMalformedCallPairs(messages, REQUIRED)).toEqual(messages)
  })
})
