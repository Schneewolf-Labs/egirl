/**
 * One live execution per task, and the park decision at the end of a run.
 *
 * Mirrors the properties of formal/TaskRunner.tla: runNow refuses a task that is already
 * running, a timed-out execution keeps its slot until it actually ends, a task paused while it
 * ran is not parked over the user's pause, and a reply that lands mid-run is not lost to the
 * park that follows.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatResponse, LLMProvider } from '../../src/providers/types'
import { createTaskRunner, type TaskRunner } from '../../src/tasks/runner'
import { createTaskStore, type TaskStore } from '../../src/tasks/store'
import { createToolExecutor } from '../../src/tools/executor'
import type { Tool } from '../../src/tools/types'
import { makeConfig, stubResponse } from '../agent/helpers'

interface Harness {
  runner: TaskRunner
  store: TaskStore
}

function makeRunner(opts: {
  provider: LLMProvider
  tools?: Tool[]
  taskTimeoutMs?: number
}): Harness {
  const workspace = mkdtempSync(join(tmpdir(), 'egirl-exclusive-'))
  const config = makeConfig(workspace)
  const store = createTaskStore(join(workspace, 'tasks.db'))
  const executor = createToolExecutor()
  for (const tool of opts.tools ?? []) executor.register(tool)
  const runner = createTaskRunner({
    config,
    tasksConfig: { ...config.tasks, taskTimeoutMs: opts.taskTimeoutMs ?? 300_000 },
    store,
    toolExecutor: executor,
    localProvider: opts.provider,
    memory: undefined,
    outbound: new Map(),
  })
  return { runner, store }
}

function createTask(store: TaskStore, name: string) {
  return store.create({
    name,
    description: name,
    kind: 'scheduled',
    prompt: 'go',
    intervalMs: 3_600_000,
    channel: 'api',
    channelTarget: 'api:default',
    createdBy: 'user',
  })
}

/** A provider whose inference waits for `open()` and ignores the abort signal, like a stuck call. */
function gatedProvider() {
  let open = () => {}
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const provider: LLMProvider = {
    name: 'stub',
    async chat(): Promise<ChatResponse> {
      await gate
      return stubResponse({ content: 'done' })
    },
  }
  return { provider, open }
}

/** A report tool whose ask goes unanswered, after running `during` (the thing that races it). */
function unansweredAsk(during: () => void): Tool {
  return {
    definition: {
      name: 'report',
      description: 'stub report',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    async execute() {
      during()
      return { success: false, output: 'No reply from supervisor', awaitingInput: true }
    },
  }
}

const ASK_THEN_END: Array<Partial<ChatResponse>> = [
  {
    tool_calls: [{ id: 'c1', name: 'report', arguments: { mode: 'ask', message: 'stuck' } }],
    finish_reason: 'tool_calls',
  },
  { content: 'No answer; ending the run.' },
]

function scripted(responses: Array<Partial<ChatResponse>>): LLMProvider {
  let n = 0
  return {
    name: 'stub',
    async chat(): Promise<ChatResponse> {
      const next = responses[Math.min(n++, responses.length - 1)]
      return stubResponse(next ?? { content: 'done' })
    },
  }
}

describe('one live execution per task', () => {
  test('runNow refuses a task that is already running', async () => {
    const { provider, open } = gatedProvider()
    const { runner, store } = makeRunner({ provider })
    const task = createTask(store, 'busy')

    const first = runner.runNow(task.id)
    await Bun.sleep(0)
    expect(runner.getRunningTaskIds()).toContain(task.id)
    const second = runner.runNow(task.id).then(
      () => 'started',
      (err: unknown) => String(err),
    )

    open()
    expect(await second).toContain('already running')
    expect((await first)?.status).toBe('success')
    expect(runner.getRunningTaskIds()).not.toContain(task.id)
    expect(store.getRecentRuns(task.id).length).toBe(1)
  })

  test('a timed-out execution keeps its slot until it actually ends', async () => {
    const { provider, open } = gatedProvider()
    const { runner, store } = makeRunner({ provider, taskTimeoutMs: 50 })
    const task = createTask(store, 'stuck')

    const run = await runner.runNow(task.id)
    expect(run?.status).toBe('failure')
    // The race gave up, but the execution is still alive: the task is still running.
    expect(runner.getRunningTaskIds()).toContain(task.id)
    expect(runner.isIdle()).toBe(false)

    open()
    await Bun.sleep(10)
    expect(runner.getRunningTaskIds()).not.toContain(task.id)
    expect(runner.isIdle()).toBe(true)
  })
})

describe('parking at the end of a run', () => {
  test('a task paused while it ran is not parked over the pause', async () => {
    let harness: Harness | undefined
    let taskId = ''
    const tool = unansweredAsk(() => harness?.store.update(taskId, { status: 'paused' }))
    harness = makeRunner({ provider: scripted(ASK_THEN_END), tools: [tool] })
    taskId = createTask(harness.store, 'paused-mid-run').id

    await harness.runner.runNow(taskId)
    expect(harness.store.get(taskId)?.status).toBe('paused')
  })

  test('a reply that lands mid-run makes the task run again instead of parking', async () => {
    let harness: Harness | undefined
    let taskId = ''
    const tool = unansweredAsk(() => harness?.runner.noteReply(taskId))
    harness = makeRunner({ provider: scripted(ASK_THEN_END), tools: [tool] })
    taskId = createTask(harness.store, 'replied-mid-run').id

    const before = Date.now()
    await harness.runner.runNow(taskId)
    const after = harness.store.get(taskId)
    expect(after?.status).toBe('active')
    expect(harness.store.getDueTasks(Date.now()).map((t) => t.id)).toContain(taskId)
    expect(after?.nextRunAt).toBeGreaterThanOrEqual(before)
  })

  test('a reply noted while nothing runs is ignored', async () => {
    const { runner, store } = makeRunner({
      provider: scripted(ASK_THEN_END),
      tools: [unansweredAsk(() => {})],
    })
    const task = createTask(store, 'idle-reply')
    runner.noteReply(task.id)

    await runner.runNow(task.id)
    expect(store.get(task.id)?.status).toBe('awaiting')
  })
})
