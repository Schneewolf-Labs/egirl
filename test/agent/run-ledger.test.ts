/**
 * The record a run's wrap-up is handed. Observed: Jaeger reported a session as done in which
 * 20 of 64 commands had failed; his soul file already said to label unverified results.
 */

import { describe, expect, test } from 'bun:test'
import { AgentLoop } from '../../src/agent/loop'
import { HONEST_REPORT } from '../../src/agent/nudges'
import { RunLedger, withRecord } from '../../src/agent/run-ledger'
import { capNote, createRunSignals } from '../../src/operator/run-signals'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { createToolExecutor } from '../../src/tools/executor'
import { makeConfig, makeWorkspace, stubResponse } from './helpers'

const ok = { success: true, output: 'ok' }
const bad = { success: false, output: 'exit 1' }

describe('RunLedger', () => {
  test('a command is judged by its last run: fixed tests are not failing ones', () => {
    const l = new RunLedger()
    l.record('execute_command', { command: 'bun test' }, bad)
    l.record('execute_command', { command: 'bun run lint' }, bad)
    l.record('execute_command', { command: 'bun test' }, ok)
    const out = l.render() ?? ''
    expect(out).toContain('3 tool calls, 2 failed')
    expect(out).toContain('still failing the last time they ran: `bun run lint`')
    expect(out).not.toContain('`bun test`')
  })

  test('names what was written and committed, and that no commit is no commit', () => {
    const l = new RunLedger()
    l.record('write_file', { path: 'src/a.ts' }, ok)
    l.record('edit_file', { path: 'src/b.ts' }, bad)
    expect(l.render()).toContain('Files written or edited: src/a.ts')
    expect(l.render()).not.toContain('src/b.ts')
    expect(l.render()).toContain('Commits: none through git_commit')
    l.record('git_commit', { message: 'Fix the parser' }, ok)
    expect(l.render()).toContain('Commits: Fix the parser')
  })

  test("a code agent's success is marked as its claim", () => {
    const l = new RunLedger()
    l.record('code_agent', { task: 'x' }, ok)
    expect(l.render()).toContain('1 delegations, 1 succeeded (its report is a claim')
  })

  test('a run with no tools adds nothing', () => {
    expect(new RunLedger().render()).toBeUndefined()
    expect(withRecord('wrap up', new RunLedger())).toBe('wrap up')
  })
})

describe('in the loop', () => {
  test('the forced summary at the cap carries the record and the three-part report', async () => {
    const executor = createToolExecutor()
    executor.register({
      definition: {
        name: 'execute_command',
        description: 'run',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
      async execute() {
        return bad
      },
    })
    let last = ''
    let n = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        last = JSON.stringify(req.messages)
        n++
        if (!req.tools?.length) return stubResponse({ content: 'summary' })
        return stubResponse({
          tool_calls: [
            { id: `c${n}`, name: 'execute_command', arguments: { command: `make test${n}` } },
          ],
          finish_reason: 'tool_calls',
        })
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(makeWorkspace()),
      toolExecutor: executor,
      localProvider: provider,
      sessionId: 'test:ledger-cap',
    })
    const res = await agent.run('go', { maxTurns: 4 })
    expect(res.turnLimitReached).toBe(true)
    expect(last).toContain('ran out of steps')
    expect(last).toContain(JSON.stringify(HONEST_REPORT).slice(1, 40))
    expect(last).toContain('4 tool calls, 4 failed')
    expect(last).toContain('still failing the last time they ran: `make test1`')
  })
})

describe('on a hosted operator', () => {
  test('the cap checklist on a tool result carries the record too', () => {
    const signals = createRunSignals()
    signals.ledger.record('execute_command', { command: 'pytest' }, bad)
    signals.steps = 38
    expect(capNote(signals, 40)).toContain('still failing the last time they ran: `pytest`')
  })
})
