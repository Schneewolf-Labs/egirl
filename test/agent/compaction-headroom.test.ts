import { describe, expect, test } from 'bun:test'
import { fitToContextWindow } from '../../src/agent/context-window'
import type { ChatMessage } from '../../src/providers/types'

const config = { contextLength: 4000, reserveForOutput: 200 }

function turn(i: number): ChatMessage[] {
  return [
    { role: 'user', content: `User message ${i} with some padding text to take up tokens here` },
    { role: 'assistant', content: `Assistant reply ${i} with some padding text to take up tokens` },
  ]
}

/** What the loop does: fit, keep what was sent (minus the notice), add a turn, fit again. */
async function run(turns: number): Promise<number> {
  let messages: ChatMessage[] = [{ role: 'user', content: 'The task' }]
  let trims = 0
  for (let i = 0; i < turns; i++) {
    messages.push(...turn(i))
    const fit = await fitToContextWindow('System prompt', messages, [], config)
    if (fit.wasTrimmed) {
      trims++
      const dropped = new Set(fit.droppedMessages)
      messages = messages.filter((m) => !dropped.has(m))
    }
  }
  return trims
}

describe('compaction headroom', () => {
  test('a trim leaves room for the turns after it instead of trimming every turn', async () => {
    const turns = 200
    const trims = await run(turns)
    expect(trims).toBeGreaterThan(0)
    // Refilled to the whole budget this trimmed on nearly every turn once full.
    expect(trims).toBeLessThan(turns / 5)
  })

  test('the most recent group is kept whole when it fits the budget, even past the target', async () => {
    const big = 'x '.repeat(2400)
    const messages: ChatMessage[] = [
      { role: 'user', content: 'The task' },
      ...turn(0),
      ...turn(1),
      { role: 'user', content: big },
    ]
    const fit = await fitToContextWindow('System prompt', messages, [], config)
    expect(fit.messages.some((m) => m.content === big)).toBe(true)
  })
})
