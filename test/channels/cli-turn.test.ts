/**
 * What the terminal offers after a run: `/continue` when the cap ended it, `/compact` when the
 * window is nearly full, and in /auto a capped run simply carries on.
 */

import { describe, expect, test } from 'bun:test'
import type { CLIInput } from '../../src/channels/cli-input'
import { runTurns } from '../../src/channels/cli-turn'
import { createWaitHistory } from '../../src/channels/cli-wait'
import type { Operator } from '../../src/operator/types'
import { CONTINUE_PROMPT } from '../../src/session/commands'
import { SessionController } from '../../src/session/controller'

function fakeInput(suggested: (string | undefined)[]): CLIInput {
  return {
    isInteractive: false,
    setPrompt() {},
    setStatus() {},
    notice() {},
    suggest: (t) => suggested.push(t),
    ask: async () => '',
    close() {},
  }
}

function fakeAgent(capped: (text: string) => boolean, utilization = 0.1) {
  const prompts: string[] = []
  const agent = {
    run: async (text: string) => {
      prompts.push(text)
      return { content: 'done', provider: 'stub', turnLimitReached: capped(text) }
    },
    contextStatus: async () => ({ contextLength: 100, totalUsed: 10, utilization }),
    getContext: () => ({ workspaceDir: '/tmp' }),
  } as unknown as Operator
  return { agent, prompts }
}

const quiet = <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log
  console.log = () => {}
  return fn().finally(() => {
    console.log = log
  })
}

describe('after a run', () => {
  test('a capped run offers /continue and stops', async () => {
    const suggested: (string | undefined)[] = []
    const { agent, prompts } = fakeAgent(() => true)
    const session = new SessionController()
    const input = fakeInput(suggested)
    await quiet(() => runTurns('go', { agent, session, input, waits: createWaitHistory() }))
    expect(prompts).toEqual(['go'])
    expect(suggested).toEqual(['/continue'])
  })

  test('in /auto a capped run continues on its own', async () => {
    const { agent, prompts } = fakeAgent((t) => t === 'go')
    const session = new SessionController({ mode: 'auto' })
    const input = fakeInput([])
    await quiet(() => runTurns('go', { agent, session, input, waits: createWaitHistory() }))
    expect(prompts).toEqual(['go', CONTINUE_PROMPT])
  })

  test('the automatic continuation is marked as a harness turn; the user turn is not', async () => {
    const marks: (boolean | undefined)[] = []
    const agent = {
      run: async (text: string, options?: { isHarnessTurn?: boolean }) => {
        marks.push(options?.isHarnessTurn)
        return { content: 'done', provider: 'stub', turnLimitReached: text === 'go' }
      },
      contextStatus: async () => ({ contextLength: 100, totalUsed: 10, utilization: 0.1 }),
      getContext: () => ({ workspaceDir: '/tmp' }),
    } as unknown as Operator
    const session = new SessionController({ mode: 'auto' })
    await quiet(() =>
      runTurns('go', { agent, session, input: fakeInput([]), waits: createWaitHistory() }),
    )
    expect(marks).toEqual([undefined, true])
  })

  test('a nearly full window offers /compact', async () => {
    const suggested: (string | undefined)[] = []
    const { agent } = fakeAgent(() => false, 0.85)
    const input = fakeInput(suggested)
    await quiet(() =>
      runTurns('go', {
        agent,
        session: new SessionController(),
        input,
        waits: createWaitHistory(),
      }),
    )
    expect(suggested).toEqual(['/compact'])
  })

  test('an ordinary run offers nothing', async () => {
    const suggested: (string | undefined)[] = []
    const { agent } = fakeAgent(() => false)
    const input = fakeInput(suggested)
    await quiet(() =>
      runTurns('go', {
        agent,
        session: new SessionController(),
        input,
        waits: createWaitHistory(),
      }),
    )
    expect(suggested).toEqual([])
  })
})
