import { describe, expect, test } from 'bun:test'
import type { AgentLoop } from '../../src/agent'
import type { AgentEventHandler } from '../../src/agent/events'
import { deliver, runTurn, type Surface } from '../../src/channels/spine'
import { ReplyBroker } from '../../src/report/broker'

function fakeAgent(
  content: string,
  opts: { toolCalls?: boolean; fail?: string } = {},
): { agent: AgentLoop; prompts: string[] } {
  const prompts: string[] = []
  const agent = {
    async run(message: string, options?: { events?: AgentEventHandler }) {
      prompts.push(message)
      if (opts.fail) throw new Error(opts.fail)
      if (opts.toolCalls) {
        options?.events?.onToolCallStart?.([
          { id: '1', name: 'web_search', arguments: { query: 'egirl' } },
        ])
      }
      return { content, provider: 'local' }
    },
  } as unknown as AgentLoop
  return { agent, prompts }
}

function fakeSurface(overrides: Partial<Surface> = {}): {
  surface: Surface
  sent: string[]
  typing: boolean[]
} {
  const sent: string[] = []
  const typing: boolean[] = []
  const surface: Surface = {
    channel: 'test',
    target: 'room',
    maxLength: 100,
    format: 'plain',
    send: async (chunk) => {
      sent.push(chunk)
    },
    typing: {
      refreshMs: 60_000,
      set: async (on) => {
        typing.push(on)
      },
    },
    ...overrides,
  }
  return { surface, sent, typing }
}

describe('runTurn', () => {
  test('runs the agent and delivers the reply with tool narration in front', async () => {
    const { agent, prompts } = fakeAgent('found it', { toolCalls: true })
    const { surface, sent } = fakeSurface()
    await runTurn(agent, surface, 'look this up')
    expect(prompts).toEqual(['look this up'])
    expect(sent).toEqual(['🔍 Web Search: "egirl"\n\nfound it'])
  })

  test('renders narration as a code block on markdown surfaces', async () => {
    const { agent } = fakeAgent('found it', { toolCalls: true })
    const { surface, sent } = fakeSurface({ format: 'markdown' })
    await runTurn(agent, surface, 'look this up')
    expect(sent).toEqual(['```\n🔍 Web Search: "egirl"\n```\nfound it'])
  })

  test('shows typing while the agent runs and clears it after', async () => {
    const { agent } = fakeAgent('ok')
    const { surface, typing } = fakeSurface()
    await runTurn(agent, surface, 'hi')
    expect(typing).toEqual([true, false])
  })

  test('a pending report ask consumes the message instead of starting a turn', async () => {
    const broker = new ReplyBroker()
    const reply = broker.awaitReply('test', 'room', 5000)
    const { agent, prompts } = fakeAgent('should not run')
    const { surface, sent, typing } = fakeSurface()
    await runTurn(agent, surface, 'yes, ship it', broker)
    expect(await reply).toBe('yes, ship it')
    expect(prompts).toEqual([])
    expect(sent).toEqual([])
    expect(typing).toEqual([])
  })

  test('reports an agent failure on the same surface instead of going silent', async () => {
    const { agent } = fakeAgent('', { fail: 'model is down' })
    const { surface, sent, typing } = fakeSurface()
    await runTurn(agent, surface, 'hi')
    expect(sent).toEqual(['Error: model is down'])
    expect(typing).toEqual([true, false])
  })

  test('a broken typing indicator never fails the turn', async () => {
    const { agent } = fakeAgent('ok')
    const { surface, sent } = fakeSurface({
      typing: {
        refreshMs: 60_000,
        set: async () => {
          throw new Error('no chat states here')
        },
      },
    })
    await runTurn(agent, surface, 'hi')
    expect(sent).toEqual(['ok'])
  })
})

describe('deliver', () => {
  test('splits long text to the surface cap', async () => {
    const { surface, sent } = fakeSurface({ maxLength: 10 })
    await deliver(surface, 'x'.repeat(25))
    expect(sent).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx'])
  })

  test('never sends an empty message', async () => {
    const { surface, sent } = fakeSurface()
    await deliver(surface, '   ')
    expect(sent).toEqual(['(empty response)'])
  })
})
