import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTaskStore, type TaskStore } from '../../src/tasks/store'
import type { NewTask } from '../../src/tasks/types'

let store: TaskStore
let dbPath: string

function makeTask(overrides: Partial<NewTask> = {}): NewTask {
  return {
    name: 'test-task',
    description: 'A test task',
    kind: 'scheduled',
    prompt: 'Do the thing',
    intervalMs: 60_000,
    channel: 'cli',
    channelTarget: 'user',
    createdBy: 'user',
    ...overrides,
  }
}

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `egirl-test-tasks-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  )
  store = createTaskStore(dbPath)
})

afterEach(() => {
  store.close()
  try {
    unlinkSync(dbPath)
  } catch {}
  try {
    unlinkSync(`${dbPath}-wal`)
  } catch {}
  try {
    unlinkSync(`${dbPath}-shm`)
  } catch {}
})

describe('TaskStore', () => {
  test('creates and retrieves a task', () => {
    const task = store.create(makeTask())
    expect(task.id).toBeDefined()
    expect(task.name).toBe('test-task')
    expect(task.status).toBe('active')

    const fetched = store.get(task.id)
    expect(fetched).toBeDefined()
    expect(fetched?.name).toBe('test-task')
  })

  test('stores new fields: cronExpression, businessHours, dependsOn', () => {
    const task = store.create(
      makeTask({
        cronExpression: '0 9 * * MON-FRI',
        businessHours: '9-17 Mon-Fri',
      }),
    )

    const fetched = store.get(task.id)!
    expect(fetched.cronExpression).toBe('0 9 * * MON-FRI')
    expect(fetched.businessHours).toBe('9-17 Mon-Fri')
  })

  test('stores task dependency', () => {
    const parent = store.create(makeTask({ name: 'parent' }))
    const child = store.create(makeTask({ name: 'child', dependsOn: parent.id }))

    const fetched = store.get(child.id)!
    expect(fetched.dependsOn).toBe(parent.id)
  })

  test('getDependents returns tasks that depend on a given task', () => {
    const parent = store.create(makeTask({ name: 'parent' }))
    store.create(makeTask({ name: 'child-1', dependsOn: parent.id }))
    store.create(makeTask({ name: 'child-2', dependsOn: parent.id }))
    store.create(makeTask({ name: 'unrelated' }))

    const dependents = store.getDependents(parent.id)
    expect(dependents).toHaveLength(2)
    expect(dependents.map((d) => d.name).sort()).toEqual(['child-1', 'child-2'])
  })

  test('updates lastErrorKind', () => {
    const task = store.create(makeTask())
    store.update(task.id, { lastErrorKind: 'rate_limit' as const })

    const fetched = store.get(task.id)!
    expect(fetched.lastErrorKind).toBe('rate_limit')
  })

  test('completeRun stores errorKind', () => {
    const task = store.create(makeTask())
    const run = store.createRun(task.id)
    store.completeRun(run.id, {
      status: 'failure',
      error: 'Rate limit exceeded',
      errorKind: 'rate_limit',
    })

    const runs = store.getRecentRuns(task.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.errorKind).toBe('rate_limit')
  })

  test('getLastSuccessfulRun returns the most recent success', () => {
    const task = store.create(makeTask())

    // Create a few runs
    const run1 = store.createRun(task.id)
    store.completeRun(run1.id, { status: 'success', result: 'first' })

    const run2 = store.createRun(task.id)
    store.completeRun(run2.id, { status: 'failure', error: 'oops' })

    const run3 = store.createRun(task.id)
    store.completeRun(run3.id, { status: 'success', result: 'third' })

    const lastSuccess = store.getLastSuccessfulRun(task.id)
    expect(lastSuccess).toBeDefined()
    expect(lastSuccess?.result).toBe('third')
  })

  test('agent-created tasks start as proposed', () => {
    const task = store.create(makeTask({ createdBy: 'agent' }))
    expect(task.status).toBe('proposed')
  })

  test('migration adds new columns to existing db', () => {
    // Close and reopen — should not fail
    store.close()
    store = createTaskStore(dbPath)

    const task = store.create(makeTask({ cronExpression: '0 9 * * *' }))
    expect(store.get(task.id)?.cronExpression).toBe('0 9 * * *')
  })
})
