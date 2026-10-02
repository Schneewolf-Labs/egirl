import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ModelTurn } from '../../src/agent/events'
import { loadConfig } from '../../src/config/index'
import type { ChatMessage, ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import {
  createShadowTutor,
  shadowTutorFor,
  uniqueToolCallIds,
} from '../../src/tracking/shadow-tutor'
import { stubResponse } from '../agent/helpers'

function turn(messages: ChatMessage[]): ModelTurn {
  return {
    messages,
    tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
    thinking: { level: 'off' },
    response: stubResponse({ content: 'operator answer' }),
  }
}

describe('uniqueToolCallIds', () => {
  test('renumbers per-turn ids and keeps each result paired with its call', () => {
    const out = uniqueToolCallIds([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_0', name: 'a', arguments: {} },
          { id: 'call_1', name: 'b', arguments: {} },
        ],
      },
      { role: 'tool', content: 'ra', tool_call_id: 'call_0' },
      { role: 'tool', content: 'rb', tool_call_id: 'call_1' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_0', name: 'c', arguments: {} }] },
      { role: 'tool', content: 'rc', tool_call_id: 'call_0' },
    ])
    expect(out[1]?.tool_calls?.map((c) => c.id)).toEqual(['call_0', 'call_1'])
    expect(out[2]?.tool_call_id).toBe('call_0')
    expect(out[3]?.tool_call_id).toBe('call_1')
    expect(out[4]?.tool_calls?.[0]?.id).toBe('call_2')
    expect(out[5]?.tool_call_id).toBe('call_2')
  })
})

describe('shadow tutor', () => {
  test('is shown the operator turn verbatim, minus llama.cpp-only settings', async () => {
    let seen: ChatRequest | undefined
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        seen = req
        return stubResponse({
          model: 'frontier',
          tool_calls: [{ id: 'x', name: 'read_file', arguments: { path: 'a' } }],
          finish_reason: 'tool_calls',
        })
      },
    }
    const t = turn([
      { role: 'system', content: 'You are egirl' },
      { role: 'user', content: 'read a' },
    ])
    const label = await shadowTutorFor(provider, 'frontier', 1000).label(t)

    expect(seen?.messages).toEqual(t.messages)
    expect(seen?.tools).toEqual(t.tools)
    expect(seen?.thinking).toBeUndefined()
    expect(seen?.cacheSlot).toBeUndefined()
    expect(label.error).toBeUndefined()
    expect(label.model).toBe('frontier')
    expect(label.tool_calls?.[0]?.name).toBe('read_file')
  })

  test('a failing tutor records the error instead of throwing', async () => {
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        throw new Error('401 unauthorized')
      },
    }
    const label = await shadowTutorFor(provider, 'frontier', 1000).label(turn([]))
    expect(label.error).toContain('401')
    expect(label.content).toBe('')
  })

  test('names the model in the request, which hosted APIs require', async () => {
    const realFetch = globalThis.fetch
    let body: Record<string, unknown> | undefined
    // @ts-expect-error test double
    globalThis.fetch = async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      const enc = new TextEncoder()
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`),
          )
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      })
      return new Response(stream, { status: 200 })
    }
    try {
      const tutor = createShadowTutor({
        endpoint: 'http://stub',
        model: 'frontier-1',
        maxConcurrent: 1,
        timeoutMs: 1000,
      })
      await tutor.label(turn([{ role: 'user', content: 'hi' }]))
    } finally {
      globalThis.fetch = realFetch
    }
    expect(body?.model).toBe('frontier-1')
    expect(body?.chat_template_kwargs).toBeUndefined()
    expect(body?.id_slot).toBeUndefined()
  })
})

describe('[tutor] config', () => {
  let dir: string
  const keys = [
    'EGIRL_CONFIG',
    'EGIRL_TUTOR_ENDPOINT',
    'EGIRL_TUTOR_MODEL',
    'EGIRL_TUTOR_API_KEY',
  ] as const
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))

  function write(extra: string): void {
    const path = join(dir, 'egirl.toml')
    writeFileSync(path, `[workspace]\npath = "${dir}/workspace"\n\n[local]\nmodel = "m"\n${extra}`)
    process.env.EGIRL_CONFIG = path
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'egirl-tutor-')).replace(/\\/g, '/')
    for (const k of keys) if (k !== 'EGIRL_CONFIG') delete process.env[k]
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  test('is absent unless configured', () => {
    write('')
    expect(loadConfig().tutor).toBeUndefined()
  })

  test('reads [tutor], dropping a trailing /v1 from the endpoint', () => {
    write('\n[tutor]\nendpoint = "https://api.example.com/v1/"\nmodel = "big"\n')
    process.env.EGIRL_TUTOR_API_KEY = 'sk-test'
    expect(loadConfig().tutor).toEqual({
      endpoint: 'https://api.example.com',
      model: 'big',
      maxConcurrent: 4,
      timeoutMs: 600_000,
      apiKey: 'sk-test',
    })
  })

  test('env switches it on without a [tutor] section', () => {
    write('')
    process.env.EGIRL_TUTOR_ENDPOINT = 'https://openrouter.ai/api'
    process.env.EGIRL_TUTOR_MODEL = 'vendor/model'
    const tutor = loadConfig().tutor
    expect(tutor?.endpoint).toBe('https://openrouter.ai/api')
    expect(tutor?.model).toBe('vendor/model')
  })
})
