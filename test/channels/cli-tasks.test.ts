/**
 * `/tasks` in the terminal: the API's task operations, as text, over the same store.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TaskDeps, tasksCommand } from '../../src/channels/cli-tasks'
import { createTaskStore, type TaskRun, type TaskStore } from '../../src/tasks'

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const strip = (s: string): string => s.replace(ANSI, '')
const NOW = 1_800_000_000_000

let store: TaskStore
let running: string[]
let notices: string[]
let ran: string[]
let activated: string[]

function deps(withRunner = true): TaskDeps {
  return {
    store,
    now: () => NOW,
    notify: (t) => notices.push(strip(t)),
    ...(withRunner && {
      runner: {
        getRunningTaskIds: () => running,
        activateTask: (id: string) => activated.push(id),
        runNow: async (id: string): Promise<TaskRun | undefined> => {
          ran.push(id)
          return {
            id: 'r1',
            taskId: id,
            startedAt: NOW - 60_000,
            completedAt: NOW,
            status: 'success',
            result: 'checked CI: green',
            error: undefined,
            errorKind: undefined,
            tokensUsed: 10,
          }
        },
      },
    }),
  }
}

const run = (arg: string, withRunner = true): string => strip(tasksCommand(arg, deps(withRunner)))

function addTask(name: string, extra: Partial<Parameters<TaskStore['create']>[0]> = {}) {
  return store.create({
    name,
    description: `${name} description`,
    kind: 'scheduled',
    prompt: 'do it',
    intervalMs: 30 * 60_000,
    channel: 'cli',
    channelTarget: 'stdout',
    createdBy: 'user',
    ...extra,
  })
}

beforeEach(() => {
  store = createTaskStore(join(mkdtempSync(join(tmpdir(), 'cli-tasks-')), 'tasks.db'))
  running = []
  notices = []
  ran = []
  activated = []
})

describe('/tasks list', () => {
  test('says so when there are none', () => {
    expect(run('')).toContain('no tasks')
  })

  test('lists each task with its schedule, and marks the one running now', () => {
    const ci = addTask('check-ci')
    addTask('digest', { cronExpression: '0 9 * * *', intervalMs: undefined })
    running = [ci.id]
    const out = run('')
    expect(out).toContain('tasks (2)')
    expect(out).toContain(`${ci.id.slice(0, 8)} running check-ci`)
    expect(out).toContain('every 30m')
    expect(out).toContain('cron 0 9 * * *')
  })

  test('a next run already passed reads as due', () => {
    const t = addTask('check-ci')
    store.update(t.id, { nextRunAt: NOW - 5_000 })
    expect(run('')).toContain('next due now')
    store.update(t.id, { nextRunAt: NOW + 10 * 60_000 })
    expect(run('')).toContain('next in 10m')
  })

  test('hides done tasks unless asked', () => {
    const done = addTask('old')
    store.update(done.id, { status: 'done' })
    addTask('live')
    expect(run('')).not.toContain(' old ')
    expect(run('')).toContain('+1 done')
    expect(run('all')).toContain('old')
  })

  test('says when the runner is off', () => {
    addTask('check-ci')
    expect(run('', false)).toContain('runner is off')
  })
})

describe('/tasks <task>', () => {
  test('finds a task by name or id prefix and shows its runs', () => {
    const t = addTask('check-ci')
    const r = store.createRun(t.id)
    store.completeRun(r.id, { status: 'failure', error: 'build red\nstack…' })
    for (const q of ['check-ci', 'CHECK-CI', t.id.slice(0, 6)]) {
      const out = run(q)
      expect(out).toContain('check-ci')
      expect(out).toContain('recent runs')
      expect(out).toContain('failed')
      expect(out).toContain('build red')
      expect(out).not.toContain('stack…')
    }
  })

  test('an unknown task says so', () => {
    addTask('a')
    expect(run('nope')).toContain('no task matches "nope"')
  })
})

describe('/tasks run|pause|resume', () => {
  test('pause and resume go through the store like the API', () => {
    const t = addTask('check-ci')
    expect(run('pause check-ci')).toContain('paused check-ci')
    expect(store.get(t.id)?.status).toBe('paused')
    expect(run('resume check-ci')).toContain('resumed check-ci')
    expect(store.get(t.id)?.status).toBe('active')
    expect(activated).toEqual([t.id])
  })

  test('run returns at once and the result arrives as a notice', async () => {
    const t = addTask('check-ci')
    expect(run('run check-ci')).toContain('running check-ci')
    await Bun.sleep(0)
    expect(ran).toEqual([t.id])
    expect(notices[0]).toContain('task check-ci ok')
    expect(notices[0]).toContain('checked CI: green')
  })

  test('run refuses a task already running, and needs a runner', () => {
    const t = addTask('check-ci')
    running = [t.id]
    expect(run('run check-ci')).toContain('already running')
    expect(run('run check-ci', false)).toContain('runner is off')
    expect(ran).toEqual([])
  })

  test('a verb with no task shows usage', () => {
    expect(run('run')).toContain('usage: /tasks')
  })
})
