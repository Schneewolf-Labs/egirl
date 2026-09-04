/**
 * Slash commands.
 *
 * One dispatcher serves the terminal, the console and every chat channel, so what a command
 * does is pinned once here. The scope decides what is available: the agent-level commands
 * work everywhere, the terminal-only ones say so rather than pretending.
 */

import { describe, expect, test } from 'bun:test'
import type { AgentLoop } from '../../src/agent'
import type { ThinkingConfig } from '../../src/providers/types'
import { handleCommand } from '../../src/session/commands'
import { SessionController } from '../../src/session/controller'

function fakeAgent(configLevel: ThinkingConfig['level'] = 'medium'): AgentLoop {
  let override: ThinkingConfig['level'] | undefined
  return {
    setThinking(level: ThinkingConfig['level'] | undefined) {
      override = level
    },
    getThinking() {
      return override
        ? { level: override, source: 'session' }
        : { level: configLevel, source: 'config' }
    },
    async contextStatus() {
      return {
        sessionId: 'cli:default',
        contextLength: 32768,
        systemPromptTokens: 4000,
        messageCount: 12,
        messageTokens: 9000,
        summaryTokens: 1200,
        totalUsed: 14200,
        available: 18568,
        utilization: 0.43,
        hasSummary: true,
      }
    },
  } as unknown as AgentLoop
}

describe('what counts as a command', () => {
  test('plain text is not a command', async () => {
    expect((await handleCommand('hello there', { agent: fakeAgent() })).handled).toBe(false)
  })

  test('a path is a sentence about a path, not a mistyped command', async () => {
    const r = await handleCommand('/etc/hosts has the wrong entry', { agent: fakeAgent() })
    expect(r.handled).toBe(false)
  })

  test('an unknown command is reported, not sent to the model', async () => {
    // A mistyped command silently becoming a chat message is confusing in a way an error is not.
    const r = await handleCommand('/mxturns 50', { agent: fakeAgent() })
    expect(r.handled).toBe(true)
    expect(r.message).toContain('unknown command')
  })

  test('is case-insensitive and tolerates trailing space', async () => {
    const session = new SessionController()
    await handleCommand('/AUTO  ', { agent: fakeAgent(), session })
    expect(session.get().mode).toBe('auto')
  })
})

describe('/think', () => {
  test('off, on and default move the session setting on the agent', async () => {
    const agent = fakeAgent('medium')
    expect((await handleCommand('/think off', { agent })).message).toBe(
      'thinking: medium (config) → off (session)',
    )
    expect(agent.getThinking()).toEqual({ level: 'off', source: 'session' })

    await handleCommand('/think on', { agent })
    expect(agent.getThinking().level).not.toBe('off')

    await handleCommand('/think default', { agent })
    expect(agent.getThinking()).toEqual({ level: 'medium', source: 'config' })
  })

  test('with no argument it reports the current level and usage', async () => {
    const r = await handleCommand('/think', { agent: fakeAgent('off') })
    expect(r.message).toContain('thinking: off (config)')
    expect(r.message).toContain('usage:')
  })

  test('rejects an unknown level without changing anything', async () => {
    const agent = fakeAgent()
    const r = await handleCommand('/think maybe', { agent })
    expect(r.message).toContain('usage:')
    expect(agent.getThinking().source).toBe('config')
  })
})

describe('/context and /settings', () => {
  test('/context summarizes the window in plain text', async () => {
    const r = await handleCommand('/context', { agent: fakeAgent() })
    expect(r.message).toContain('43% of 32,768 tokens')
    expect(r.message).toContain('12 messages')
    expect(r.message).toContain('compacted')
  })

  test('/settings shows only what the surface has', async () => {
    const agent = fakeAgent()
    expect((await handleCommand('/settings', { agent })).message).toBe('thinking medium (config)')
    const withSession = await handleCommand('/settings', {
      agent,
      session: new SessionController(),
    })
    expect(withSession.message).toContain('maxTurns 10')
  })
})

describe('terminal-only commands', () => {
  test('/maxturns changes the cap mid-session', async () => {
    const session = new SessionController()
    const r = await handleCommand('/maxturns 50', { agent: fakeAgent(), session })
    expect(r.handled).toBe(true)
    expect(session.get().maxTurns).toBe(50)
  })

  test('/maxturns rejects nonsense instead of silently accepting it', async () => {
    const session = new SessionController()
    for (const bad of ['/maxturns 0', '/maxturns -1', '/maxturns abc', '/maxturns 9999']) {
      await handleCommand(bad, { agent: fakeAgent(), session })
    }
    expect(session.get().maxTurns).toBe(10)
  })

  test('/auto and /reasoning toggle', async () => {
    const session = new SessionController()
    const scope = { agent: fakeAgent(), session }
    await handleCommand('/auto', scope)
    expect(session.get().mode).toBe('auto')
    await handleCommand('/reasoning', scope)
    expect(session.get().showReasoning).toBe(false)
  })

  test('/clear reports how many it dropped', async () => {
    const session = new SessionController()
    session.enqueue('x')
    session.enqueue('y')
    expect((await handleCommand('/clear', { agent: fakeAgent(), session })).message).toContain('2')
  })

  test('/quit signals exit', async () => {
    const r = await handleCommand('/quit', { agent: fakeAgent(), session: new SessionController() })
    expect(r.quit).toBe(true)
  })

  test('are refused, not ignored, on a surface without a session', async () => {
    for (const cmd of ['/auto', '/maxturns 5', '/reasoning', '/queue', '/clear', '/quit']) {
      const r = await handleCommand(cmd, { agent: fakeAgent() })
      expect(r.handled).toBe(true)
      expect(r.quit).toBeUndefined()
      expect(r.message).toContain('only available in the terminal')
    }
  })

  test('/help lists the terminal commands only where they work', async () => {
    const agent = fakeAgent()
    const room = (await handleCommand('/help', { agent })).message ?? ''
    expect(room).toContain('/think')
    expect(room).not.toContain('/maxturns')
    const tty = (await handleCommand('/help', { agent, session: new SessionController() })).message
    expect(tty).toContain('/maxturns')
  })
})
