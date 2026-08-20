/**
 * Repetition guard for the continuation path.
 *
 * The cost of a false positive here is real -- an honestly truncated answer gets aborted --
 * so half these tests are negatives: ordinary truncation shapes that must NEVER trip the
 * guard. The positives are the degenerate-loop shapes that motivated it.
 */

import { describe, expect, test } from 'bun:test'
import { isRepetitionDominated } from '../../src/agent/repetition-guard'

describe('degenerate loops are caught', () => {
  test('one sentence echoed to fill the budget', () => {
    const echo = 'I need to check the RFH header structure again to be sure. '
    expect(isRepetitionDominated(echo.repeat(40))).toBe(true)
  })

  test('a repeated line, newline-separated', () => {
    const line = 'Processing record 1 of the resource file with the standard layout...\n'
    expect(isRepetitionDominated(line.repeat(30))).toBe(true)
  })

  test('repetition that does not align to line boundaries', () => {
    // No newlines at all -- the sliding-window pass has to catch this one.
    const frag = 'the header is 7 bytes then the name then the offset and '
    expect(isRepetitionDominated(frag.repeat(25))).toBe(true)
  })

  test('a loop with a preamble is still dominated', () => {
    const preamble = 'Let me analyze the resource file format now.\n'
    const echo = 'The record starts with a u32 length field followed by the name. '
    expect(isRepetitionDominated(preamble + echo.repeat(30))).toBe(true)
  })
})

describe('ordinary truncation is never blocked (fail-open)', () => {
  test('prose cut off mid-sentence', () => {
    const prose = Array.from(
      { length: 30 },
      (_, i) =>
        `Step ${i}: examine byte offset ${i * 16} and note the ${i % 2 ? 'length' : 'flag'} field there.`,
    ).join('\n')
    expect(isRepetitionDominated(prose)).toBe(false)
  })

  test('code with similar-looking lines', () => {
    const code = Array.from(
      { length: 40 },
      (_, i) => `  expect(parse(records[${i}]).offset).toBe(${i * 512})`,
    ).join('\n')
    expect(isRepetitionDominated(code)).toBe(false)
  })

  test('a heading legitimately repeated a few times', () => {
    const section = (n: number) =>
      `## Analysis\nRecord ${n} holds ${n * 3} bytes of palette data, offset differs per record, ` +
      `and the checksum uses a different seed each time (${n * 7}).\n`
    expect(isRepetitionDominated([1, 2, 3, 4].map(section).join(''))).toBe(false)
  })

  test('short fragments are never judged', () => {
    expect(isRepetitionDominated('yes. yes. yes. yes. yes. yes.')).toBe(false)
  })

  test('empty and non-string fail open', () => {
    expect(isRepetitionDominated('')).toBe(false)
    // @ts-expect-error deliberate wrong type -- the guard must not throw
    expect(isRepetitionDominated(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration: the guard wired into the real AgentLoop continuation path.
// ---------------------------------------------------------------------------
import { AgentLoop } from '../../src/agent/loop'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

describe('AgentLoop aborts a repetition-dominated continuation', () => {
  test('one call, no continuation retries, abort marker in the answer', async () => {
    let calls = 0
    const echo = 'I need to check the RFH header structure again to be sure. '
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        calls++
        // Every call returns the same degenerate loop, truncated at the budget. Without the
        // guard the loop would burn all MAX_CONTINUATION_RETRIES stitching echo onto echo.
        return stubResponse({ content: echo.repeat(40), finish_reason: 'length' })
      },
    }

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:repetition',
    })

    const response = await agent.run('analyze the file')

    expect(calls).toBe(1)
    expect(response.content).toContain('[Response aborted: the model entered a repetition loop.]')
    expect(response.continuationRetries).toBeUndefined()
  })

  test('an honestly truncated response still gets its continuation', async () => {
    let calls = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        calls++
        if (calls === 1) {
          // Varied prose, genuinely cut off -- must NOT be mistaken for a loop.
          const prose = Array.from(
            { length: 30 },
            (_, i) => `Step ${i}: byte offset ${i * 16} holds the ${i % 2 ? 'length' : 'flag'}.`,
          ).join('\n')
          return stubResponse({ content: prose, finish_reason: 'length' })
        }
        return stubResponse({ content: ' And that completes the analysis.' })
      },
    }

    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'test:honest-truncation',
    })

    const response = await agent.run('analyze the file')

    expect(calls).toBe(2)
    expect(response.content).toContain('And that completes the analysis.')
    expect(response.continuationRetries).toBe(1)
  })
})
