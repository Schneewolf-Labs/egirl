/**
 * A run cut short by shutdown is not a completed run.
 *
 * An aborted agent run returns normally ({ content: '', aborted: true }) instead of throwing,
 * so the runner used to book it as a success: the run row read success with an empty result,
 * and a oneshot went to done and never ran again.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { createTaskRunner, type TaskRunner } from '../../src/tasks/runner'
import { createTaskStore, type TaskStore } from '../../src/tasks/store'
import type { TaskKind } from '../../src/tasks/types'
import { createToolExecutor } from '../../src/tools/executor'
import { makeConfig } from '../agent/helpers'

/** A provider whose inference never finishes on its own; it ends only when the run is aborted. */
function hangingProvider(): LLMProvider {
  return {
    name: 'stub',
    chat(req: ChatRequest): Promise<ChatResponse> {
      return new Promise((_, reject) => {
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  }
}

let runner: TaskRunner | undefined
let store: TaskStore | undefined

afterEach(() => {
  runner?.stop()
  store?.close()
  runner = undefined
  store = undefined
})

function setup(kind: TaskKind) {
  const workspace = mkdtempSync(join(tmpdir(), 'egirl-interrupt-'))
  const config = makeConfig(workspace)
  store = createTaskStore(join(workspace, 'tasks.db'))
  runner = createTaskRunner({
    config,
    tasksConfig: config.tasks,
    store,
    toolExecutor: createToolExecutor(),
    localProvider: hangingProvider(),
    memory: undefined,
    outbound: new Map(),
  })
  const task = store.create({
    name: `interrupted-${kind}`,
    description: 'cut short',
    kind,
    prompt: 'go',
    ...(kind === 'scheduled' && { intervalMs: 3_600_000 }),
    channel: 'api',
    channelTarget: 'api:default',
    createdBy: 'user',
  })
  return { runner, store, task }
}

describe('a run interrupted by shutdown', () => {
  test('a oneshot is booked as interrupted, not success, and left runnable', async () => {
    const { runner, store, task } = setup('oneshot')

    const pending = runner.runNow(task.id)
    await Bun.sleep(10)
    const before = Date.now()
    runner.stop()
    const run = await pending

    expect(run?.status).toBe('failure')
    expect(run?.error).toMatch(/interrupted by shutdown/i)
    const [row] = store.getRecentRuns(task.id)
    expect(row?.status).toBe('failure')
    expect(row?.error).toMatch(/interrupted by shutdown/i)

    const after = store.get(task.id)
    expect(after?.status).toBe('active')
    expect(after?.nextRunAt).toBeGreaterThanOrEqual(before)
    expect(after?.nextRunAt).toBeLessThanOrEqual(Date.now() + 60_000)
    // Not the task's failure: nothing counts toward auto-pause, and it did not complete a run.
    expect(after?.consecutiveFailures).toBe(0)
    expect(after?.runCount).toBe(0)
  })

  test('a scheduled task is re-armed soon, not pushed out a full interval', async () => {
    const { runner, store, task } = setup('scheduled')

    const pending = runner.runNow(task.id)
    await Bun.sleep(10)
    runner.stop()
    const run = await pending

    expect(run?.status).toBe('failure')
    const after = store.get(task.id)
    expect(after?.status).toBe('active')
    expect(after?.nextRunAt).toBeLessThanOrEqual(Date.now() + 60_000)
    expect(after?.consecutiveFailures).toBe(0)
  })

  test('a task paused while it ran keeps its pause', async () => {
    const { runner, store, task } = setup('oneshot')

    const pending = runner.runNow(task.id)
    await Bun.sleep(10)
    store.update(task.id, { status: 'paused' })
    runner.stop()
    await pending

    expect(store.get(task.id)?.status).toBe('paused')
  })
})
