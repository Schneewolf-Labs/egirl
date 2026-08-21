/**
 * The awaiting-input task state — the durable half of a blocking report ask.
 *
 * When a run's report ask goes unanswered, the tool result carries awaitingInput; it surfaces
 * through AgentResponse, and the runner parks the task as 'awaiting' instead of rescheduling.
 * The scheduler skips non-active tasks, so a parked run is distinguishable from a finished
 * one, and a reply on the task's session (POST /chat) resumes it.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatResponse, LLMProvider } from '../../src/providers/types'
import { createTaskRunner } from '../../src/tasks/runner'
import { createTaskStore } from '../../src/tasks/store'
import { createToolExecutor } from '../../src/tools/executor'
import type { Tool } from '../../src/tools/types'
import { makeConfig, stubResponse } from '../agent/helpers'

function stubReportTool(result: { awaitingInput?: boolean }): Tool {
  return {
    definition: {
      name: 'report',
      description: 'stub report',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    async execute() {
      return {
        success: !result.awaitingInput,
        output: result.awaitingInput ? 'No reply from supervisor' : 'Supervisor replied: proceed',
        ...(result.awaitingInput && { awaitingInput: true }),
      }
    },
  }
}

function makeRunner(tool: Tool, responses: Array<Partial<ChatResponse>>) {
  const workspace = mkdtempSync(join(tmpdir(), 'egirl-awaiting-'))
  const config = makeConfig(workspace)
  const store = createTaskStore(join(workspace, 'tasks.db'))
  const executor = createToolExecutor()
  executor.register(tool)

  let n = 0
  const provider: LLMProvider = {
    name: 'stub',
    async chat(): Promise<ChatResponse> {
      const next = responses[Math.min(n, responses.length - 1)]
      n++
      return stubResponse(next ?? { content: 'done' })
    },
  }

  const runner = createTaskRunner({
    config,
    tasksConfig: config.tasks,
    store,
    toolExecutor: executor,
    localProvider: provider,
    memory: undefined,
    outbound: new Map(),
  })
  return { runner, store }
}

describe('awaiting-input task state', () => {
  test('an unanswered report ask parks the task as awaiting', async () => {
    const { runner, store } = makeRunner(stubReportTool({ awaitingInput: true }), [
      {
        tool_calls: [{ id: 'c1', name: 'report', arguments: { mode: 'ask', message: 'stuck' } }],
        finish_reason: 'tool_calls',
      },
      { content: 'Parked — wrote notes, ending the run.' },
    ])
    const task = store.create({
      name: 'grind',
      description: 'grind the thing',
      kind: 'oneshot',
      prompt: 'go grind',
      unbounded: true,
      channel: 'api',
      channelTarget: 'api:default',
      createdBy: 'user',
    })

    const run = await runner.runNow(task.id)
    expect(run?.status).toBe('success')
    expect(store.get(task.id)?.status).toBe('awaiting')
    // The transition ledger records why.
    const transitions = store.getTransitions(task.id)
    expect(transitions[0]?.toStatus).toBe('awaiting')
    expect(transitions[0]?.reason).toContain('awaiting supervisor input')
  })

  test('an answered ask does not park', async () => {
    const { runner, store } = makeRunner(stubReportTool({}), [
      {
        tool_calls: [{ id: 'c1', name: 'report', arguments: { mode: 'ask', message: 'stuck' } }],
        finish_reason: 'tool_calls',
      },
      { content: 'Got direction, continuing.' },
    ])
    const task = store.create({
      name: 'grind2',
      description: 'grind the thing',
      kind: 'oneshot',
      prompt: 'go grind',
      channel: 'api',
      channelTarget: 'api:default',
      createdBy: 'user',
    })

    const run = await runner.runNow(task.id)
    expect(run?.status).toBe('success')
    expect(store.get(task.id)?.status).toBe('active')
  })

  test('a parked task is not due for scheduling', async () => {
    const { runner, store } = makeRunner(stubReportTool({ awaitingInput: true }), [
      {
        tool_calls: [{ id: 'c1', name: 'report', arguments: { mode: 'ask', message: 'stuck' } }],
        finish_reason: 'tool_calls',
      },
      { content: 'Parked.' },
    ])
    const task = store.create({
      name: 'grind3',
      description: 'recurring grind',
      kind: 'scheduled',
      prompt: 'go grind',
      intervalMs: 1,
      channel: 'api',
      channelTarget: 'api:default',
      createdBy: 'user',
    })
    await runner.runNow(task.id)
    expect(store.get(task.id)?.status).toBe('awaiting')
    // Even far in the future, the parked task never comes due.
    expect(store.getDueTasks(Date.now() + 86_400_000).map((t) => t.id)).not.toContain(task.id)
  })
})
