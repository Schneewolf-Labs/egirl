import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatResponse, LLMProvider } from '../../src/providers/types'
import { createTaskRunner, type TaskRunner } from '../../src/tasks/runner'
import { createTaskStore, type TaskStore } from '../../src/tasks/store'
import { createToolExecutor } from '../../src/tools/executor'
import { makeConfig } from '../agent/helpers'

function stubProvider(): LLMProvider {
  return {
    name: 'stub',
    async chat(): Promise<ChatResponse> {
      return {
        content: 'ok',
        provider: 'stub',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'stub',
      } as ChatResponse
    },
  }
}

let runner: TaskRunner | undefined
let store: TaskStore | undefined

afterEach(() => {
  runner?.stop()
  store?.close()
})

describe('startup re-arm', () => {
  test('an active scheduled task with no nextRunAt is re-armed on start', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'egirl-rearm-'))
    const config = makeConfig(workspace)
    store = createTaskStore(join(workspace, 'tasks.db'))
    const task = store.create({
      name: 'grind',
      description: 'long grind',
      kind: 'scheduled',
      prompt: 'go',
      intervalMs: 3_600_000,
      unbounded: true,
      channel: 'cli',
      channelTarget: 'user',
      createdBy: 'user',
    })
    // Simulate the mid-run-kill aftermath: active, but no scheduled next run.
    store.update(task.id, { nextRunAt: undefined })
    expect(store.get(task.id)?.nextRunAt).toBeUndefined()

    runner = createTaskRunner({
      config,
      tasksConfig: config.tasks,
      store,
      toolExecutor: createToolExecutor(),
      localProvider: stubProvider(),
      memory: undefined,
      outbound: new Map(),
    })
    runner.start()

    const rearmed = store.get(task.id)
    expect(rearmed?.nextRunAt).toBeDefined()
    expect(rearmed?.nextRunAt).toBeLessThanOrEqual(Date.now())
  })

  test('paused tasks and tasks with a scheduled run are left alone', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'egirl-rearm2-'))
    const config = makeConfig(workspace)
    store = createTaskStore(join(workspace, 'tasks.db'))

    const scheduled = store.create({
      name: 'scheduled',
      description: 'has a next run',
      kind: 'scheduled',
      prompt: 'go',
      intervalMs: 3_600_000,
      channel: 'cli',
      channelTarget: 'user',
      createdBy: 'user',
    })
    const future = store.get(scheduled.id)?.nextRunAt
    expect(future).toBeDefined()

    const paused = store.create({
      name: 'paused',
      description: 'paused task',
      kind: 'scheduled',
      prompt: 'go',
      intervalMs: 3_600_000,
      channel: 'cli',
      channelTarget: 'user',
      createdBy: 'user',
    })
    store.update(paused.id, { status: 'paused', nextRunAt: undefined })

    runner = createTaskRunner({
      config,
      tasksConfig: config.tasks,
      store,
      toolExecutor: createToolExecutor(),
      localProvider: stubProvider(),
      memory: undefined,
      outbound: new Map(),
    })
    runner.start()

    expect(store.get(scheduled.id)?.nextRunAt).toBe(future)
    expect(store.get(paused.id)?.nextRunAt).toBeUndefined()
  })
})
