/**
 * task_run_now starts the task and returns; it does not await the run.
 *
 * The tool executes under the session mutex, and the task run needs that same mutex for its own
 * tool calls. Awaiting the run inside the tool held the lock the run was queued on, so the run
 * could only get it by failing its acquire timeout. Model: formal/SessionMutex.tla.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionMutex } from '../../src/agent/session-mutex'
import type { ChatResponse, LLMProvider } from '../../src/providers/types'
import { createTaskRunner } from '../../src/tasks/runner'
import { createTaskStore } from '../../src/tasks/store'
import { createTaskTools } from '../../src/tools/builtin/tasks'
import { makeConfig, makeExecutorWithNoop, stubResponse } from '../agent/helpers'

describe('task_run_now', () => {
  test('returns while the task runs, so the task can take the mutex its caller held', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'egirl-run-now-'))
    const config = makeConfig(workspace)
    const store = createTaskStore(join(workspace, 'tasks.db'))
    const mutex = new SessionMutex(500)
    let n = 0
    const provider: LLMProvider = {
      name: 'stub',
      async chat(): Promise<ChatResponse> {
        // The task's first turn calls a tool, which needs the mutex.
        if (n++ === 0) {
          return stubResponse({
            tool_calls: [{ id: 'c1', name: 'noop', arguments: {} }],
            finish_reason: 'tool_calls',
          })
        }
        return stubResponse({ content: 'task done' })
      },
    }
    const runner = createTaskRunner({
      config,
      tasksConfig: config.tasks,
      store,
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      memory: undefined,
      outbound: new Map(),
      sessionMutex: mutex,
    })
    const { taskRunNowTool } = createTaskTools(store, runner, 20, () => ({
      channel: 'api',
      channelTarget: 'api:default',
    }))
    const task = store.create({
      name: 'nested',
      description: 'uses a tool',
      kind: 'scheduled',
      prompt: 'go',
      intervalMs: 3_600_000,
      channel: 'api',
      channelTarget: 'api:default',
      createdBy: 'user',
    })

    // The calling run's tool phase, as AgentLoop runs it: under the mutex.
    const result = await mutex.run(() => taskRunNowTool.execute({ id: task.id }, workspace))
    expect(result.success).toBe(true)
    expect(result.output).toContain('Started')

    // Starting it again while it runs is refused rather than doubling it up.
    const again = await taskRunNowTool.execute({ id: task.id }, workspace)
    expect(again.success).toBe(false)
    expect(again.output).toContain('already running')

    for (let i = 0; i < 200 && !runner.isIdle(); i++) await Bun.sleep(5)
    const [run] = store.getRecentRuns(task.id)
    expect(run?.status).toBe('success')
    expect(run?.result).toBe('task done')
  })
})
