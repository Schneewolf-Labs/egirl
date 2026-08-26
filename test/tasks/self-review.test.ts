import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, ChatResponse, LLMProvider } from '../../src/providers/types'
import { digestRun, runSelfReview } from '../../src/tasks/self-review'
import { makeConfig } from '../agent/helpers'

function messagesFixture(): ChatMessage[] {
  return [
    { role: 'system', content: 'you are zero' },
    { role: 'user', content: 'continue the RE work' },
    {
      role: 'assistant',
      content: 'Running the probe now.',
      tool_calls: [{ id: 'a', name: 'execute_command', arguments: { command: 'probe.sh' } }],
    },
    { role: 'tool', content: 'huge probe output '.repeat(50), tool_call_id: 'a' },
    {
      role: 'assistant',
      content: `Found it: the gate reads LEGO.INI before the AVI. ${'x'.repeat(300)}`,
    },
  ]
}

function stubProvider(reply: string, delayMs = 0): LLMProvider {
  return {
    name: 'stub',
    async chat(): Promise<ChatResponse> {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      return {
        content: reply,
        provider: 'stub',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'stub',
      } as ChatResponse
    },
  }
}

describe('digestRun', () => {
  test('keeps dialogue, names tools, drops payloads and system', () => {
    const d = digestRun(messagesFixture())
    expect(d).toContain('User: continue the RE work')
    expect(d).toContain('[tools: execute_command]')
    expect(d).not.toContain('huge probe output')
    expect(d).not.toContain('you are zero')
  })

  test('over-long digests keep the tail', () => {
    const messages: ChatMessage[] = Array.from({ length: 200 }, (_, i) => ({
      role: 'assistant' as const,
      content: `finding number ${i} ${'pad'.repeat(30)}`,
    }))
    const d = digestRun(messages, 2000)
    expect(d.length).toBeLessThan(2200)
    expect(d).toContain('earlier turns omitted')
    expect(d).toContain('finding number 199')
    expect(d).not.toContain('finding number 0 ')
  })
})

describe('runSelfReview', () => {
  test('skips when no skills dirs are configured', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'egirl-sr-'))
    const config = makeConfig(ws) // helpers default: skills.dirs = []
    const ran = await runSelfReview('t1', 'test-task', messagesFixture(), {
      config,
      provider: stubProvider('nothing to capture'),
    })
    expect(ran).toBe(false)
  })

  test('runs the restricted fork and resolves', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'egirl-sr2-'))
    const skillsDir = join(ws, 'skills')
    mkdirSync(skillsDir, { recursive: true })
    const config = { ...makeConfig(ws), skills: { dirs: [skillsDir] } }
    const ran = await runSelfReview('t2', 'test-task', messagesFixture(), {
      config,
      provider: stubProvider('nothing to capture'),
    })
    expect(ran).toBe(true)
  })

  test('single-flight: a second review for the same task is skipped while one runs', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'egirl-sr3-'))
    const skillsDir = join(ws, 'skills')
    mkdirSync(skillsDir, { recursive: true })
    const config = { ...makeConfig(ws), skills: { dirs: [skillsDir] } }
    const deps = { config, provider: stubProvider('nothing to capture', 150) }
    const first = runSelfReview('t3', 'test-task', messagesFixture(), deps)
    const second = await runSelfReview('t3', 'test-task', messagesFixture(), deps)
    expect(second).toBe(false)
    expect(await first).toBe(true)
  })
})

describe('skill inventory injection', () => {
  test('the review prompt carries the actual skill inventory', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'egirl-sr4-'))
    const skillsDir = join(ws, 'skills')
    mkdirSync(join(skillsDir, 'wine-probe-capture'), { recursive: true })
    writeFileSync(join(skillsDir, 'wine-probe-capture/SKILL.md'), '# Wine Probe Capture\n\nx')
    const config = { ...makeConfig(ws), skills: { dirs: [skillsDir] } }
    let seenPrompt = ''
    const provider: LLMProvider = {
      name: 'stub',
      async chat({ messages }): Promise<ChatResponse> {
        seenPrompt = String(messages.find((m) => m.role === 'user')?.content ?? '')
        return {
          content: 'nothing to capture',
          provider: 'stub',
          usage: { input_tokens: 1, output_tokens: 1 },
          model: 'stub',
        } as ChatResponse
      },
    }
    await runSelfReview('t9', 'test-task', messagesFixture(), { config, provider })
    expect(seenPrompt).toContain('Existing skills (prefer patching these')
    expect(seenPrompt).toContain('wine-probe-capture')
  })
})
