/**
 * The seeded mailbox task runs on the ordinary task machinery but never calls the model: the
 * runner polls instead. And a oneshot — what a mailbox request becomes — runs once, not on
 * every tick after, which for a mailbox task would answer the sender again each time.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatResponse, LLMProvider } from '../../src/providers/types'
import { MAILBOX_TASK_NAME, seedMailboxTask } from '../../src/tasks/mailbox-task'
import { createTaskRunner } from '../../src/tasks/runner'
import { createTaskStore } from '../../src/tasks/store'
import { createToolExecutor } from '../../src/tools/executor'
import { makeConfig, stubResponse } from '../agent/helpers'

function setup(pollMailbox?: () => Promise<string>) {
  const workspace = mkdtempSync(join(tmpdir(), 'egirl-mailbox-task-'))
  const config = makeConfig(workspace)
  const store = createTaskStore(join(workspace, 'tasks.db'))
  let modelCalls = 0
  const provider: LLMProvider = {
    name: 'stub',
    async chat(): Promise<ChatResponse> {
      modelCalls++
      return stubResponse({ content: 'done' })
    },
  }
  const runner = createTaskRunner({
    config,
    tasksConfig: config.tasks,
    store,
    toolExecutor: createToolExecutor(),
    localProvider: provider,
    memory: undefined,
    outbound: new Map(),
    pollMailbox,
  })
  return { runner, store, modelCalls: () => modelCalls }
}

describe('mailbox task', () => {
  test('polls without a model call', async () => {
    let polls = 0
    const { runner, store, modelCalls } = setup(async () => {
      polls++
      return 'Mailbox: 1 task'
    })
    seedMailboxTask({ store, runner, schedule: '*/5 * * * *', channel: 'api', channelTarget: 'x' })
    const task = store.list().find((t) => t.name === MAILBOX_TASK_NAME)

    const run = await runner.runNow(task?.id as string)

    expect(polls).toBe(1)
    expect(modelCalls()).toBe(0)
    expect(run?.result).toBe('Mailbox: 1 task')
    expect(store.get(task?.id as string)?.nextRunAt).toBeGreaterThan(Date.now())
  })

  test('seeding twice keeps one task', () => {
    const { runner, store } = setup()
    const seed = { store, runner, schedule: '*/5 * * * *', channel: 'api', channelTarget: 'x' }
    seedMailboxTask(seed)
    seedMailboxTask({ ...seed, schedule: '*/10 * * * *' })
    const seeded = store.list().filter((t) => t.name === MAILBOX_TASK_NAME)
    expect(seeded).toHaveLength(1)
    expect(seeded[0]?.cronExpression).toBe('*/10 * * * *')
  })
})

describe('oneshot', () => {
  test('is not due again after its run', async () => {
    const { runner, store } = setup()
    const task = store.create({
      name: 'mail from luna',
      description: 'd',
      kind: 'oneshot',
      prompt: 'answer luna',
      channel: 'api',
      channelTarget: 'x',
      createdBy: 'wald:luna',
    })
    runner.activateTask(task.id)
    expect(store.getDueTasks(Date.now()).map((t) => t.id)).toContain(task.id)

    await runner.runNow(task.id)

    expect(store.getDueTasks(Date.now() + 60_000).map((t) => t.id)).not.toContain(task.id)
  })
})
