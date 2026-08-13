import { describe, expect, test } from 'bun:test'
import { fitToContextWindow } from '../../src/agent/context-window'
import type { ChatMessage } from '../../src/providers/types'

/**
 * Compaction must never drop the most recent turn.
 *
 * The tail loop walks backward from the newest group and `break`s at the first group that does
 * not fit. If the newest group is *itself* larger than the tail budget — a web_search returning
 * ten results, a fetched page, any long tool result — it breaks on the first iteration and keeps
 * zero tail groups. The model is then handed the first user message plus a summary, with the turn
 * it is meant to answer deleted.
 *
 * Observed in a real research run: sixteen searches, then
 * `Interior compaction: dropped 19 middle messages, kept head + 0 tail groups`, and the model
 * replied by scaffolding an unrelated project. It was not confused — the request was gone.
 *
 * The `result.length === 0` fallback further down does not catch this, because the head group
 * survives and the result is therefore non-empty.
 */

const tiny = { contextLength: 400, reserveForOutput: 50 }

function bulk(words: number, prefix: string): string {
  return `${prefix} ${'lorem ipsum dolor sit amet '.repeat(words)}`
}

describe('compaction keeps the most recent turn', () => {
  test('an oversized final tool result does not wipe the tail', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Research agent harnesses and report back.' },
      { role: 'assistant', content: 'Searching now.' },
      { role: 'user', content: bulk(30, 'filler turn one') },
      { role: 'assistant', content: bulk(30, 'filler turn two') },
      // The newest group on its own blows the entire budget.
      { role: 'user', content: bulk(400, 'SEARCH RESULTS: the thing the model must answer') },
    ]

    const { messages: result } = await fitToContextWindow('System', messages, [], tiny)

    const kept = result.map((m) => String(m.content)).join('\n')
    expect(kept).toContain('SEARCH RESULTS')
  })

  test('the last message survives even when every group is oversized', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: bulk(300, 'huge first') },
      { role: 'assistant', content: bulk(300, 'huge second') },
      { role: 'user', content: bulk(300, 'huge and final — answer this') },
    ]

    const { messages: result } = await fitToContextWindow('System', messages, [], tiny)

    expect(result.length).toBeGreaterThan(0)
    expect(result.map((m) => String(m.content)).join('\n')).toContain('huge and final')
  })
})
