/**
 * `/tasks` in the terminal: what is scheduled, what ran, and the levers to run, pause or resume.
 *
 * Background tasks were only visible through the HTTP API, the web console or the agent's own
 * task tools -- a terminal session sharing the same tasks.db had no way to see them. These are
 * the API's operations (`/tasks`, `/tasks/:id/history|pause|resume|run`) with the same store
 * calls, rendered as text. Pure over the store and runner, so it can be tested without a
 * terminal and answered mid-turn.
 */

import type { Task, TaskRun, TaskRunner, TaskStore } from '../tasks'
import { colors, DIM, RESET } from '../ui/theme'

export interface TaskDeps {
  store: Pick<TaskStore, 'list' | 'get' | 'update' | 'getRecentRuns'>
  /** Absent when the runner is off: listing still works, running does not. */
  runner?: Pick<TaskRunner, 'getRunningTaskIds' | 'runNow' | 'activateTask'>
  /** Prints a run-now result when it finishes, which can be well after the command returned. */
  notify(text: string): void
  now?: () => number
}

const USAGE = 'usage: /tasks [all] · /tasks <id|name> · /tasks run|pause|resume <id|name>'

/** Answer a `/tasks …` line. Returns the text to print. */
export function tasksCommand(arg: string, deps: TaskDeps): string {
  const [verb = '', ...rest] = arg.trim().split(/\s+/)
  const target = rest.join(' ')
  if (verb === '' || verb === 'all') return listTasks(deps, verb === 'all')
  if (verb === 'run' || verb === 'pause' || verb === 'resume') {
    if (!target) return `${DIM}${USAGE}${RESET}`
    const found = findTask(deps, target)
    if (typeof found === 'string') return found
    return act(verb, found, deps)
  }
  if (verb === 'help') return `${DIM}${USAGE}${RESET}`
  const found = findTask(deps, arg.trim())
  return typeof found === 'string' ? found : taskDetail(found, deps)
}

/** An id prefix or a name (case-insensitive). A string result is the message for no/many hits. */
function findTask(deps: TaskDeps, query: string): Task | string {
  const exact = deps.store.get(query)
  if (exact) return exact
  const q = query.toLowerCase()
  const all = deps.store.list()
  const byName = all.filter((t) => t.name.toLowerCase() === q)
  const hits = byName.length > 0 ? byName : all.filter((t) => t.id.startsWith(query))
  if (hits.length === 1) return hits[0] as Task
  if (hits.length === 0) return `${colors().warning}no task matches "${query}"${RESET}`
  const names = hits.map((t) => `${shortId(t)} ${t.name}`).join(', ')
  return `${colors().warning}"${query}" matches ${hits.length} tasks:${RESET} ${names}`
}

function act(verb: 'run' | 'pause' | 'resume', task: Task, deps: TaskDeps): string {
  const c = colors()
  if (verb === 'pause') {
    deps.store.update(task.id, { status: 'paused' }, 'paused via CLI')
    return `${c.accent}paused${RESET} ${task.name}`
  }
  if (!deps.runner) return `${c.warning}the task runner is off in this process${RESET}`
  if (verb === 'resume') {
    deps.store.update(
      task.id,
      { status: 'active', consecutiveFailures: 0, lastErrorKind: undefined },
      'resumed via CLI',
    )
    deps.runner.activateTask(task.id)
    return `${c.accent}resumed${RESET} ${task.name}`
  }
  if (deps.runner.getRunningTaskIds().includes(task.id)) {
    return `${c.warning}${task.name} is already running${RESET}`
  }
  // A run takes minutes; the prompt stays free and the result arrives as a notice.
  deps.runner
    .runNow(task.id)
    .then((run) => {
      if (run) deps.notify(`${c.accent}task ${task.name}${RESET} ${runLine(run, deps)}`)
    })
    .catch((error: unknown) => {
      deps.notify(`${c.error}task ${task.name} failed to start:${RESET} ${String(error)}`)
    })
  return `${c.accent}running${RESET} ${task.name} ${DIM}— the result prints here when it ends${RESET}`
}

function listTasks(deps: TaskDeps, includeDone: boolean): string {
  const c = colors()
  const all = deps.store.list()
  const shown = includeDone ? all : all.filter((t) => t.status !== 'done')
  const hidden = all.length - shown.length
  if (shown.length === 0) {
    const more = hidden > 0 ? ` ${DIM}(${hidden} done — /tasks all)${RESET}` : ''
    return `${DIM}no tasks${RESET}${more}`
  }
  const running = new Set(deps.runner?.getRunningTaskIds() ?? [])
  const lines = shown.map((t) => {
    const state = running.has(t.id) ? `${c.secondary}running${RESET}` : statusWord(t.status)
    const next =
      t.nextRunAt && t.status === 'active' ? ` · next ${upcoming(t.nextRunAt, deps)}` : ''
    const last = t.lastRunAt ? ` · last ${relative(t.lastRunAt, deps)}` : ''
    const fails =
      t.consecutiveFailures > 0 ? ` · ${c.error}${t.consecutiveFailures} failed${RESET}` : ''
    return `  ${DIM}${shortId(t)}${RESET} ${state} ${t.name} ${DIM}${schedule(t)}${next}${last}${RESET}${fails}`
  })
  const footer = hidden > 0 ? [`${DIM}  +${hidden} done — /tasks all${RESET}`] : []
  const off = deps.runner ? [] : [`${c.warning}  the task runner is off in this process${RESET}`]
  return [
    `${c.primary}tasks${RESET} ${DIM}(${shown.length})${RESET}`,
    ...lines,
    ...footer,
    ...off,
  ].join('\n')
}

function taskDetail(task: Task, deps: TaskDeps): string {
  const c = colors()
  const isRunning = deps.runner?.getRunningTaskIds().includes(task.id) ?? false
  const lines = [
    `${c.primary}${task.name}${RESET} ${DIM}${task.id}${RESET}`,
    `  ${isRunning ? `${c.secondary}running${RESET}` : statusWord(task.status)} ${DIM}· ${schedule(task)} · ${task.runCount} runs · created by ${task.createdBy}${RESET}`,
  ]
  if (task.nextRunAt && task.status === 'active') {
    lines.push(`  ${DIM}next run ${upcoming(task.nextRunAt, deps)}${RESET}`)
  }
  if (task.description) lines.push(`  ${task.description}`)
  const runs = deps.store.getRecentRuns(task.id, 5)
  lines.push(runs.length > 0 ? `${c.accent}recent runs${RESET}` : `${DIM}  no runs yet${RESET}`)
  for (const run of runs) lines.push(`  ${runLine(run, deps)}`)
  lines.push(`${DIM}  /tasks run|pause|resume ${shortId(task)}${RESET}`)
  return lines.join('\n')
}

function runLine(run: TaskRun, deps: TaskDeps): string {
  const c = colors()
  const word =
    run.status === 'success'
      ? `${c.success}ok${RESET}`
      : run.status === 'failure'
        ? `${c.error}failed${RESET}`
        : `${DIM}${run.status}${RESET}`
  const took = run.completedAt ? ` · ${duration(run.completedAt - run.startedAt)}` : ''
  const text = (run.status === 'failure' ? run.error : run.result) ?? ''
  const first = text.split('\n').find((l) => l.trim()) ?? ''
  const gist = first.length > 100 ? `${first.slice(0, 100)}…` : first
  return `${word} ${DIM}${relative(run.startedAt, deps)}${took}${RESET}${gist ? ` ${gist}` : ''}`
}

function statusWord(status: Task['status']): string {
  const c = colors()
  if (status === 'active') return `${c.success}active${RESET}`
  if (status === 'failed') return `${c.error}failed${RESET}`
  if (status === 'awaiting') return `${c.warning}awaiting you${RESET}`
  if (status === 'proposed') return `${c.warning}proposed${RESET}`
  return `${DIM}${status}${RESET}`
}

function schedule(task: Task): string {
  if (task.kind === 'oneshot') return 'once'
  if (task.cronExpression) return `cron ${task.cronExpression}`
  if (task.intervalMs) return `every ${duration(task.intervalMs)}`
  return task.kind
}

const shortId = (task: Task): string => task.id.slice(0, 8)

function relative(at: number, deps: TaskDeps): string {
  const delta = at - (deps.now?.() ?? Date.now())
  const span = duration(Math.abs(delta))
  return delta >= 0 ? `in ${span}` : `${span} ago`
}

/** A next-run time that has already passed is due, waiting on the next tick or a free slot. */
function upcoming(at: number, deps: TaskDeps): string {
  return at <= (deps.now?.() ?? Date.now()) ? 'due now' : relative(at, deps)
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 6) / 10
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}
