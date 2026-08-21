/**
 * A wall-clock timeout is a checkpoint boundary for an unbounded task, not a failure.
 *
 * An unbounded run that reaches its time budget was warned to wrap up and has already persisted
 * its work; counting it as a failure would march a healthy long-running task toward auto-pause.
 * Bounded tasks keep the old behaviour — there a timeout more likely means a genuine hang.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatResponse, LLMProvider } from '../../src/providers/types'
import { createTaskRunner } from '../../src/tasks/runner'
import { createTaskStore } from '../../src/tasks/store'
import { createToolExecutor } from '../../src/tools/executor'
import { makeConfig } from '../agent/helpers'

/** Provider whose every inference sleeps past the task timeout, forcing the wall-clock stop. */
function slowProvider(): LLMProvider {
  return {
    name: 'stub',
    async chat(): Promise<ChatResponse> {
      await new Promise((r) => setTimeout(r, 300))
      return {
        content: 'x',
        provider: 'stub',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'stub',
      } as ChatResponse
    },
  }
}

function makeRunner(unbounded: boolean) {
  const workspace = mkdtempSync(join(tmpdir(), 'egirl-timeout-'))
  const config = makeConfig(workspace)
  const store = createTaskStore(join(workspace, 'tasks.db'))
  const runner = createTaskRunner({
    config,
    // Tiny budget so the slow provider always overruns it.
    tasksConfig: { ...config.tasks, taskTimeoutMs: 100 },
    store,
    toolExecutor: createToolExecutor(),
    localProvider: slowProvider(),
    memory: undefined,
    outbound: new Map(),
  })
  return { runner, store }
}

describe('wall-clock timeout treatment', () => {
  test('an unbounded task that overruns its budget is not counted as a failure', async () => {
    const { runner, store } = makeRunner(true)
    const task = store.create({
      name: 'grind',
      description: 'long grind',
      kind: 'scheduled',
      prompt: 'go',
      intervalMs: 3_600_000,
      unbounded: true,
      channel: 'api',
      channelTarget: 'api:default',
      createdBy: 'user',
    })

    const run = await runner.runNow(task.id)
    const after = store.get(task.id)
    expect(run?.status).toBe('success')
    expect(after?.status).toBe('active') // NOT paused
    expect(after?.consecutiveFailures).toBe(0) // NOT counted as a failure
    expect(after?.nextRunAt).toBeGreaterThan(0) // rescheduled normally
  })

  test('a bounded task that times out is still a failure', async () => {
    const { runner, store } = makeRunner(false)
    const task = store.create({
      name: 'oneoff',
      description: 'bounded',
      kind: 'oneshot',
      prompt: 'go',
      unbounded: false,
      channel: 'api',
      channelTarget: 'api:default',
      createdBy: 'user',
    })

    const run = await runner.runNow(task.id)
    const after = store.get(task.id)
    expect(run?.status).toBe('failure')
    expect(after?.consecutiveFailures).toBe(1)
  })
})
