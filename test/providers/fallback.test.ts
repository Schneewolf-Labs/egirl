import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { triggerCompaction } from '../../src/agent/background'
import { loadConfig } from '../../src/config'
import type { RuntimeConfig } from '../../src/config/schema'
import { createProviderRegistry } from '../../src/providers'
import {
  AUX_REPROBE_INTERVAL_MS,
  createAuxFallbackProvider,
  isAuxUnreachable,
} from '../../src/providers/fallback'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { setTraceStore, type TraceEvent, type TraceStore } from '../../src/tracking/traces'
import { log } from '../../src/util/logger'

/**
 * `[local.auxiliary]` pointed at a server that was not running (Kira and Zero at :8215 since
 * Sept 11) used to fail every compaction summary and memory extraction, each behind a warn line.
 * The wrapper sends the same request to the operator instead, says so once, and probes back.
 */

function respond(model: string): ChatResponse {
  return { content: `from ${model}`, usage: { input_tokens: 1, output_tokens: 1 }, model }
}

function okProvider(name: string): LLMProvider & { chat: ReturnType<typeof mock> } {
  return { name, chat: mock(async (_req: ChatRequest) => respond(name)) }
}

function refused(): Error {
  // What Bun's fetch throws for a closed port.
  return Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), {
    code: 'ConnectionRefused',
  })
}

/** An auxiliary whose behaviour each test switches between down, up, and a 4xx. */
function switchableAux(): {
  provider: LLMProvider & { chat: ReturnType<typeof mock> }
  state: { mode: 'down' | 'up' | 'bad-request' }
} {
  const state: { mode: 'down' | 'up' | 'bad-request' } = { mode: 'down' }
  const provider = {
    name: 'llamacpp/small-4b',
    chat: mock(async (_req: ChatRequest) => {
      if (state.mode === 'down') throw refused()
      if (state.mode === 'bad-request') {
        throw new Error('llama.cpp error: 400 - {"error":"invalid grammar"}')
      }
      return respond('aux')
    }),
  }
  return { provider, state }
}

const req: ChatRequest = { messages: [{ role: 'user', content: 'summarize this' }] }

let traces: TraceEvent[]
let warn: ReturnType<typeof spyOn>
let info: ReturnType<typeof spyOn>
let error: ReturnType<typeof spyOn>

beforeEach(() => {
  traces = []
  setTraceStore({ record: (e: TraceEvent) => traces.push(e) } as unknown as TraceStore)
  warn = spyOn(log, 'warn').mockImplementation(() => {})
  info = spyOn(log, 'info').mockImplementation(() => {})
  error = spyOn(log, 'error').mockImplementation(() => {})
})

afterEach(() => {
  setTraceStore(null)
  warn.mockRestore()
  info.mockRestore()
  error.mockRestore()
})

function fallbackWarnings(): unknown[][] {
  return warn.mock.calls.filter((c: unknown[]) => c[0] === 'aux-fallback')
}

describe('auxiliary fallback', () => {
  test('a refused connection is served by the operator, announced once, and traced', async () => {
    const { provider: aux } = switchableAux()
    const operator = okProvider('operator')
    const wrapped = createAuxFallbackProvider({
      auxiliary: aux,
      operator,
      endpoint: 'http://localhost:8215',
      now: () => 1_000,
    })

    for (let i = 0; i < 3; i++) {
      const response = await wrapped.chat(req)
      expect(response.model).toBe('operator')
    }

    expect(operator.chat).toHaveBeenCalledTimes(3)
    // The same request, not a rebuilt one.
    expect(operator.chat.mock.calls[0]?.[0]).toBe(req)
    // Probed once; the next two went straight to the operator inside the re-probe window.
    expect(aux.chat).toHaveBeenCalledTimes(1)

    const warnings = fallbackWarnings()
    expect(warnings).toHaveLength(1)
    const message = String(warnings[0]?.[1])
    expect(message).toContain('http://localhost:8215')
    expect(message).toContain('operator')
    expect(message).toContain('[local.auxiliary]')

    const fallbackTraces = traces.filter((t) => t.name === 'aux_fallback')
    expect(fallbackTraces).toHaveLength(1)
    expect(fallbackTraces[0]?.kind).toBe('aux')
    expect(fallbackTraces[0]?.success).toBe(false)
  })

  test('a 4xx is the server answering: no fallback, the error propagates', async () => {
    const { provider: aux, state } = switchableAux()
    state.mode = 'bad-request'
    const operator = okProvider('operator')
    const wrapped = createAuxFallbackProvider({
      auxiliary: aux,
      operator,
      endpoint: 'http://localhost:8215',
    })

    await expect(wrapped.chat(req)).rejects.toThrow('400')
    expect(operator.chat).not.toHaveBeenCalled()
    expect(fallbackWarnings()).toHaveLength(0)
  })

  test('a caller abort propagates without falling back', async () => {
    const controller = new AbortController()
    controller.abort()
    const aux: LLMProvider = {
      name: 'aux',
      chat: async () => {
        throw new DOMException('The operation was aborted.', 'AbortError')
      },
    }
    const operator = okProvider('operator')
    const wrapped = createAuxFallbackProvider({ auxiliary: aux, operator, endpoint: 'x' })

    await expect(wrapped.chat({ ...req, signal: controller.signal })).rejects.toThrow()
    expect(operator.chat).not.toHaveBeenCalled()
  })

  test('the auxiliary takes the work back after the re-probe interval, logged once', async () => {
    const { provider: aux, state } = switchableAux()
    const operator = okProvider('operator')
    let clock = 10_000
    const wrapped = createAuxFallbackProvider({
      auxiliary: aux,
      operator,
      endpoint: 'http://localhost:8215',
      now: () => clock,
    })

    expect((await wrapped.chat(req)).model).toBe('operator')

    // The server comes back, but inside the window nothing tries it.
    state.mode = 'up'
    clock += AUX_REPROBE_INTERVAL_MS - 1
    expect((await wrapped.chat(req)).model).toBe('operator')
    expect(aux.chat).toHaveBeenCalledTimes(1)

    clock += 1
    expect((await wrapped.chat(req)).model).toBe('aux')
    expect((await wrapped.chat(req)).model).toBe('aux')
    expect(aux.chat).toHaveBeenCalledTimes(3)

    const recoveries = info.mock.calls.filter((c: unknown[]) => c[0] === 'aux-fallback')
    expect(recoveries).toHaveLength(1)
    expect(String(recoveries[0]?.[1])).toContain('answering again')
    expect(traces.filter((t) => t.name === 'aux_recovered')).toHaveLength(1)
  })

  test('a failed re-probe stays quiet and keeps serving from the operator', async () => {
    const { provider: aux } = switchableAux()
    const operator = okProvider('operator')
    let clock = 0
    const wrapped = createAuxFallbackProvider({
      auxiliary: aux,
      operator,
      endpoint: 'http://localhost:8215',
      now: () => clock,
    })

    await wrapped.chat(req)
    clock += AUX_REPROBE_INTERVAL_MS
    expect((await wrapped.chat(req)).model).toBe('operator')
    expect(aux.chat).toHaveBeenCalledTimes(2)
    expect(fallbackWarnings()).toHaveLength(1)
  })

  test('classifies reachability, not answers', () => {
    expect(isAuxUnreachable(refused())).toBe(true)
    expect(isAuxUnreachable(new Error('connect ECONNREFUSED 127.0.0.1:8215'))).toBe(true)
    expect(isAuxUnreachable(new Error('getaddrinfo ENOTFOUND aux.lan'))).toBe(true)
    expect(isAuxUnreachable(new Error('The operation timed out.'))).toBe(true)
    expect(isAuxUnreachable(new Error('llama.cpp error: 503 - loading model'))).toBe(true)
    expect(isAuxUnreachable(new Error('llama.cpp error: 400 - bad request'))).toBe(false)
    expect(isAuxUnreachable(new Error('llama.cpp error: 408 - request timeout'))).toBe(false)
    expect(isAuxUnreachable(new Error('Unexpected token in JSON'))).toBe(false)
  })
})

describe('compaction when the auxiliary and the operator both fail', () => {
  test('logs at error and leaves a marked gap in the summary, not silence', async () => {
    const down = (): LLMProvider => ({
      name: 'down',
      chat: async () => {
        throw refused()
      },
    })
    const wrapped = createAuxFallbackProvider({
      auxiliary: down(),
      operator: down(),
      endpoint: 'http://localhost:8215',
    })

    let summary: string | undefined
    await triggerCompaction({
      droppedMessages: [
        { role: 'user', content: 'Migrate the auth tables to the new schema' },
        { role: 'assistant', content: 'On it.' },
      ],
      provider: wrapped,
      existingSummary: '- Earlier: set up the database',
      memory: null,
      conversationStore: null,
      sessionId: 's1',
      onSummary: (s) => {
        summary = s
      },
    })

    expect(error.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(String(error.mock.calls[0]?.[1])).toContain('2 dropped messages')

    // The previous summary survives, the gap is named, and the user's request is kept.
    expect(summary).toContain('set up the database')
    expect(summary).toContain('2 earlier messages were compacted without a model summary')
    expect(summary).toContain('Migrate the auth tables')

    const failed = traces.filter((t) => t.name === 'compaction' && t.success === false)
    expect(failed).toHaveLength(1)
  })
})

describe('registry', () => {
  function withAux(aux?: RuntimeConfig['local']['auxiliary']): RuntimeConfig {
    const base = loadConfig()
    return { ...base, local: { ...base.local, auxiliary: aux } }
  }

  test('no [local.auxiliary] means no wrapper and no auxiliary, as before', () => {
    const registry = createProviderRegistry(withAux(undefined))
    expect(registry.auxiliary).toBeUndefined()
  })

  test('a configured auxiliary keeps its own name behind the wrapper', () => {
    const registry = createProviderRegistry(
      withAux({ endpoint: 'http://localhost:8215', model: 'small-4b' }),
    )
    expect(registry.auxiliary?.name).toContain('small-4b')
  })
})
