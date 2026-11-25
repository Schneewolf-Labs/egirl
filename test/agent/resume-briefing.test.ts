import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import { buildResumeBriefing, RESUME_PREFIX } from '../../src/agent/resume-briefing'
import { ConversationStore } from '../../src/conversation/store'
import type { ChatMessage, ChatRequest, LLMProvider } from '../../src/providers/types'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from './helpers'

const NOW = 1_000_000_000_000
const MIN = 60_000

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  name,
  arguments: args,
})

const midWrite: ChatMessage[] = [
  { role: 'user', content: 'port the decoder to C' },
  { role: 'assistant', content: '', tool_calls: [call('1', 'execute_command', { command: 'ls' })] },
  { role: 'tool', content: 'a.py', tool_call_id: '1' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [call('2', 'write_file', { path: 'src/decode.c', content: '...' })],
  },
  { role: 'tool', content: 'wrote', tool_call_id: '2' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      call('3', 'edit_file', { path: 'src/decode.c' }),
      call('4', 'execute_command', {}),
    ],
  },
]

describe('resume briefing', () => {
  test('a run cut off mid-action says what was running, the request and what was done', () => {
    const b = buildResumeBriefing(midWrite, { lastActiveAt: NOW - 3 * 60 * MIN, now: NOW })
    expect(b).toStartWith(`${RESUME_PREFIX} Its last activity was 3 h ago.]`)
    expect(b).toContain('results were never recorded: edit_file, execute_command')
    expect(b).toContain("The operator's last request: port the decoder to C")
    expect(b).toContain('execute_command ×2, write_file, edit_file')
    expect(b).toContain('Files you wrote or edited since then: src/decode.c')
    expect(b).toContain('Check the current state')
  })

  test('tool results nobody answered, and an unanswered message, both count as cut off', () => {
    const recent = { lastActiveAt: NOW - MIN, now: NOW }
    expect(buildResumeBriefing(midWrite.slice(0, 3), recent)).toContain('before you answered them')
    expect(buildResumeBriefing(midWrite.slice(0, 1), recent)).toContain('operator’s last message')
  })

  test('a clean, recent ending needs no briefing; a clean, old one gets a short one', () => {
    const clean: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    expect(buildResumeBriefing(clean, { lastActiveAt: NOW - 5 * MIN, now: NOW })).toBeUndefined()
    const old = buildResumeBriefing(clean, { lastActiveAt: NOW - 2 * 24 * 60 * MIN, now: NOW })
    expect(old).toContain('2 days ago')
    expect(old).not.toContain('stopped')
    expect(buildResumeBriefing([], { now: NOW })).toBeUndefined()
  })
})

describe('resume briefing in the loop', () => {
  function agentOn(store: ConversationStore, seen: ChatRequest[]): AgentLoop {
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req) {
        seen.push(req)
        return stubResponse({ content: 'ok' })
      },
    }
    return new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId: 'cli:resume',
      conversationStore: store,
    })
  }
  const briefings = (req: ChatRequest | undefined) =>
    (req?.messages ?? []).filter(
      (m) => typeof m.content === 'string' && m.content.startsWith(RESUME_PREFIX),
    )

  test('the first run on a reloaded, cut-off transcript is briefed once, and it is not saved', async () => {
    const store = new ConversationStore(':memory:')
    store.appendMessages('cli:resume', midWrite.slice(0, 5))
    const seen: ChatRequest[] = []
    const agent = agentOn(store, seen)

    await agent.run('where were we?')
    expect(briefings(seen[0])).toHaveLength(1)
    const sent = seen[0]?.messages ?? []
    // The briefing sits right before the new message.
    expect(sent[sent.length - 1]?.content).toBe('where were we?')
    expect(String(sent[sent.length - 2]?.content)).toStartWith(RESUME_PREFIX)

    await agent.run('next')
    expect(briefings(seen[1])).toHaveLength(1) // still in this run's window, not added again
    const saved = store.loadMessages('cli:resume')
    expect(saved.some((m) => String(m.content).startsWith(RESUME_PREFIX))).toBe(false)
  })

  test('a fresh session is not briefed', async () => {
    const seen: ChatRequest[] = []
    await agentOn(new ConversationStore(':memory:'), seen).run('hello')
    expect(briefings(seen[0])).toHaveLength(0)
  })
})
