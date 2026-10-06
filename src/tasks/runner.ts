import { readFileSync } from 'node:fs'
import { AgentLoop } from '../agent/loop'
import { subscribeAll } from '../agent/session-events'
import type { SessionMutex } from '../agent/session-mutex'
import type { AgentLoopDeps } from '../agent/types'
import type { RuntimeConfig } from '../config'
import type { ConversationStore } from '../conversation'
import type { MemoryManager } from '../memory'
import { extractLessonsFromTask, extractMemories } from '../memory/extractor'
import { retrieveForContext } from '../memory/retrieval'
import type { LLMProvider } from '../providers/types'
import { gatherStandup } from '../standup'
import type { ToolExecutor } from '../tools'
import { errorMessage } from '../util/errors'
import { log } from '../util/logger'
import { resolveUserPath } from '../util/paths'
import { parseScheduleExpression } from './cron'
import { RunDeadline } from './deadline'
import { classifyError, getRetryPolicy } from './error-classify'
import { HEARTBEAT_TASK_NAME, heartbeatPreCheck } from './heartbeat'
import { MAILBOX_TASK_NAME } from './mailbox-task'
import { calculateNextRun, isWithinBusinessHours, parseBusinessHours } from './schedule'
import { runSelfReview } from './self-review'
import type { TaskStore } from './store'
import {
  createTaskControls,
  type EndRequest,
  endContent,
  type TaskControls,
  timeoutResumeNudge,
} from './task-controls'
import type { Task, TaskRun, TasksConfig } from './types'

const TASK_SYSTEM_PROMPT = `You are executing a background task. Be concise and focused.
Use memory tools to store any findings worth remembering across runs.
Use memory_recall for temporal context (e.g. "what happened last run").
If you need context from previous runs, use memory_search.`

/** Upper bound on the pinned state brief (~4k tokens). The DONE ledger belongs here; deep
 * history stays in the agent's own notes, read on demand. Truncated head keeps the ledger,
 * which by convention sits at the top of the file. */
const MAX_STATE_BRIEF_CHARS = 16000

/** How long past its hard timeout a claimed run holds the task before another process may take it. */
const CLAIM_LEASE_MARGIN_MS = 10 * 60_000

/**
 * How soon a run interrupted by shutdown is due again. Not immediately: the dying process's
 * aborted execution may still be winding down (persisting its transcript) until it exits, and
 * another live process on this tasks.db must not start the task beside it.
 */
const SHUTDOWN_REARM_DELAY_MS = 30_000

/** How one execution is run: its abort signal, moving deadline, and per-run tools. */
interface ExecutionPlan {
  signal: AbortSignal
  /** Current hard deadline (ms epoch); read each turn because an extension moves it. */
  deadline: () => number
  wrapupMarginMs: number
  /** request_extension / end_task, for bounded runs. */
  extraTools?: TaskControls['tools']
  /** Set when this run continues a bounded run that hit its time limit (its length, in min). */
  resumeAfterMinutes?: number
}

/** What one execution produced, as the runner needs it to book the run. */
interface ExecutionOutcome {
  content: string
  awaitingInput: boolean
  /** The agent run ended because its signal was aborted, not because it finished. */
  aborted?: boolean
  tokensUsed?: number
}

/**
 * Frame a state-file's content as a pinned, settled-ground-truth block for the system prompt.
 * Empty content yields undefined (nothing to pin). Over-long content is truncated head-first so
 * the DONE ledger — by convention at the top of the file — is what survives. Pure for testing.
 */
export function formatStateBrief(content: string, sourcePath: string): string | undefined {
  const trimmed = content.trim()
  if (!trimmed) return undefined
  const body =
    trimmed.length > MAX_STATE_BRIEF_CHARS
      ? `${trimmed.slice(0, MAX_STATE_BRIEF_CHARS)}\n\n[state brief truncated — full file at ${sourcePath}]`
      : trimmed
  return [
    '[Pinned task state — settled ground truth, reloaded every run so it survives context',
    'compaction. Treat everything below as already PROVEN unless you find direct evidence',
    'otherwise; do NOT re-derive or re-verify work recorded here as done. Build forward from',
    'it. Deep history lives in your notes, not here.]',
    '',
    body,
  ].join('\n')
}

export interface OutboundChannel {
  send(target: string, message: string): Promise<void>
}

export interface TaskRunnerDeps {
  config: RuntimeConfig
  tasksConfig: TasksConfig
  store: TaskStore
  toolExecutor: ToolExecutor
  localProvider: LLMProvider
  auxProvider?: LLMProvider
  memory: MemoryManager | undefined
  outbound: Map<string, OutboundChannel>
  /** Conversation store for tasks with persist_conversation enabled */
  conversationStore?: ConversationStore
  /** Shared mutex to serialize agent runs across entry points */
  sessionMutex?: SessionMutex
  /**
   * Called when a run parks waiting on a human. This is the one moment where the difference
   * between a console and a notification matters: the agent has stopped, and nothing will move
   * until somebody answers -- which they cannot do if they do not know.
   */
  onAwaitingInput?: (task: Task) => void
  /** One pass over the Wald mailbox, for the seeded `mailbox` task. Absent = mailbox off here. */
  pollMailbox?: () => Promise<string>
}

export class TaskRunner {
  private deps: TaskRunnerDeps
  private tickTimer: ReturnType<typeof setInterval> | undefined
  private runningCount = 0
  private runningTasks: Map<string, { controller: AbortController }> = new Map()
  /** Running tasks whose session got a reply mid-run; see noteReply(). */
  private repliedDuringRun = new Set<string>()
  private lastInteractionAt: number = Date.now()
  private unsubscribeBus: (() => void) | undefined

  constructor(deps: TaskRunnerDeps) {
    this.deps = deps
  }

  start(): void {
    // Re-arm active scheduled tasks left with no nextRunAt. A process restart that killed a
    // run mid-flight skipped the completion path that reschedules, leaving the task active
    // but permanently unscheduled — it then sat parked until someone triggered it by hand.
    for (const task of this.deps.store.list({ status: 'active' })) {
      if (
        task.kind === 'scheduled' &&
        !task.nextRunAt &&
        (task.intervalMs || task.cronExpression)
      ) {
        this.deps.store.update(
          task.id,
          { nextRunAt: Date.now() },
          'Re-armed on startup: active with no scheduled run',
        )
        log.info('tasks', `Re-armed ${task.name} (${task.id}): active with no nextRunAt`)
      }
    }
    // Presence, for discovery's idle check: any run that is not a task's own is a human talking
    // to the agent on some channel.
    this.unsubscribeBus = subscribeAll((sessionId, event) => {
      if (event.t === 'run_start' && !sessionId.startsWith('task:')) this.recordInteraction()
    })
    const { tickIntervalMs } = this.deps.tasksConfig
    this.tickTimer = setInterval(() => this.tick(), tickIntervalMs)
    log.info('tasks', `Task runner started (tick=${tickIntervalMs}ms)`)
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = undefined
    this.unsubscribeBus?.()
    this.unsubscribeBus = undefined

    // The reason is what tells executeTask this run was cut short by shutdown, not finished:
    // an aborted agent run returns normally (aborted: true) rather than throwing.
    for (const [, entry] of this.runningTasks) {
      entry.controller.abort('shutdown')
    }
    this.runningTasks.clear()

    log.info('tasks', 'Task runner stopped')
  }

  /** Record user interaction for idle detection (used by discovery) */
  recordInteraction(): void {
    this.lastInteractionAt = Date.now()
  }

  getLastInteractionAt(): number {
    return this.lastInteractionAt
  }

  isRunning(): boolean {
    return this.tickTimer !== undefined
  }

  isIdle(): boolean {
    return this.runningCount === 0
  }

  getCurrentTaskId(): string | undefined {
    const first = this.runningTasks.keys().next()
    return first.done ? undefined : first.value
  }

  /** All currently executing task IDs */
  getRunningTaskIds(): string[] {
    return [...this.runningTasks.keys()]
  }

  /**
   * Abort a task's in-flight run. Returns false if the task is not currently executing.
   * The run ends the same way a timeout does — through the AbortController the run was
   * started with — so cleanup and run bookkeeping are identical to every other abort.
   */
  abortTask(taskId: string): boolean {
    const entry = this.runningTasks.get(taskId)
    if (!entry) return false
    entry.controller.abort('user')
    return true
  }

  /** Activate a task — set next_run for scheduled/oneshot */
  activateTask(taskId: string): void {
    const task = this.deps.store.get(taskId)
    if (!task) return

    if (task.kind === 'scheduled') {
      const nextRunAt = this.calculateTaskNextRun(task)
      this.deps.store.update(taskId, { nextRunAt })
    }
    if (task.kind === 'oneshot') {
      this.deps.store.update(taskId, { nextRunAt: Date.now() })
    }
  }

  /**
   * A reply landed on the task's session while it was not parked. If the task is running, the
   * run cannot see it (its loop loaded the transcript before the reply was written), so when
   * the run then parks on an unanswered ask it runs again instead: nothing else would wake it.
   * Model: formal/TaskRunner.tla (NoLostWakeup).
   */
  noteReply(taskId: string): void {
    if (this.runningTasks.has(taskId)) this.repliedDuringRun.add(taskId)
  }

  /**
   * Trigger a task immediately regardless of schedule. Refuses a task that is already running:
   * two executions would share its transcript and workspace. Model: formal/TaskRunner.tla.
   */
  async runNow(taskId: string): Promise<TaskRun | undefined> {
    const task = this.deps.store.get(taskId)
    if (!task) return undefined
    if (this.runningTasks.has(taskId)) throw new Error(`Task ${taskId} is already running`)
    return this.executeTask(task)
  }

  private calculateTaskNextRun(task: Task, now?: Date): number {
    const currentTime = now ?? new Date()
    const businessHours = task.businessHours ? parseBusinessHours(task.businessHours) : undefined

    if (task.cronExpression) {
      const schedule = parseScheduleExpression(task.cronExpression)
      if (schedule) {
        return calculateNextRun({
          cronSchedule: schedule,
          businessHours,
          now: currentTime,
        })
      }
    }

    return calculateNextRun({
      intervalMs: task.intervalMs,
      businessHours,
      now: currentTime,
    })
  }

  private async tick(): Promise<void> {
    const maxConcurrent = this.deps.tasksConfig.maxConcurrentTasks
    if (this.runningCount >= maxConcurrent) return

    const due = this.deps.store.getDueTasks(Date.now())
    for (const task of due) {
      if (this.runningCount >= maxConcurrent) return
      if (this.runningTasks.has(task.id)) continue

      // Enforce dependency ordering: skip if dependency hasn't completed successfully
      if (task.dependsOn) {
        const dep = this.deps.store.get(task.dependsOn)
        if (dep) {
          const lastRun = this.deps.store.getLastSuccessfulRun(dep.id)
          if (
            !lastRun ||
            (task.lastRunAt && lastRun.completedAt && lastRun.completedAt <= task.lastRunAt)
          ) {
            continue
          }
        }
      }

      if (task.businessHours) {
        const hours = parseBusinessHours(task.businessHours)
        if (hours && !isWithinBusinessHours(new Date(), hours)) {
          const nextRunAt = this.calculateTaskNextRun(task)
          this.deps.store.update(task.id, { nextRunAt })
          continue
        }
      }

      // Another process on this tasks.db may have picked the same due task this tick.
      const leaseUntil = Date.now() + this.maxRunMs() + CLAIM_LEASE_MARGIN_MS
      if (
        task.nextRunAt === undefined ||
        !this.deps.store.claimDue(task.id, task.nextRunAt, leaseUntil)
      ) {
        continue
      }

      this.executeTask(task).catch((err) =>
        log.error('tasks', `Scheduled task ${task.id} failed: ${err}`),
      )
    }
  }

  /** Longest a run can last: its budget plus every extension it could be granted. */
  private maxRunMs(): number {
    const { taskTimeoutMs, extensions, maxExtensionRatio } = this.deps.tasksConfig
    return taskTimeoutMs * (1 + (extensions ? Math.max(0, maxExtensionRatio) : 0))
  }

  private async executeTask(task: Task): Promise<TaskRun> {
    this.runningCount++
    const abortController = new AbortController()
    this.runningTasks.set(task.id, { controller: abortController })

    // Read before this run is created: whether the previous one ended on the time limit.
    const resumeAfterMinutes = this.timedOutRunToResume(task)
    const run = this.deps.store.createRun(task.id)
    const timeoutMs = this.deps.tasksConfig.taskTimeoutMs
    const signal = abortController.signal
    // The wall-clock instant this run will be hard-aborted — movable by a granted extension —
    // and how long before it the agent is warned to wrap up. The margin scales with the budget
    // so a longer round gets a longer wind-down, capped so it never eats most of a short one.
    const deadline = new RunDeadline(timeoutMs, () => abortController.abort('timeout'))
    const wrapupMarginMs = Math.min(Math.round(timeoutMs * 0.15), 10 * 60_000)
    const controls = this.createControls(task, deadline)

    log.info('tasks', `Executing task: ${task.name} (${task.id})`)

    const execution = this.doExecute(task, {
      signal,
      deadline: () => deadline.at,
      wrapupMarginMs,
      extraTools: controls?.tools,
      resumeAfterMinutes,
    })
    try {
      const outcome = await Promise.race([execution, deadline.expired])
      if (outcome.aborted && signal.reason === 'shutdown') return this.recordInterrupted(task, run)
      const ended = controls?.endRequest()
      if (ended) return await this.recordEnded(task, run, ended, outcome.tokensUsed)
      // The hard abort can end the agent run before the race's own timer rejects; it is the
      // same timeout either way, not a finished run.
      if (outcome.aborted && signal.reason === 'timeout') {
        throw new Error(`Task timed out after ${timeoutMs + deadline.extended}ms`)
      }
      return await this.recordSuccess(task, run, outcome)
    } catch (err) {
      if (signal.reason === 'shutdown') return this.recordInterrupted(task, run)
      // The agent declared the outcome itself (end_task) and the deadline then cut a tool in
      // the same batch short: book what it declared, not a timeout that would redo the work.
      const ended = controls?.endRequest()
      if (ended) return await this.recordEnded(task, run, ended)
      const errorMsg = errorMessage(err)

      // An unbounded run reaching its wall-clock time budget is a scheduled checkpoint boundary,
      // not a failure. It was warned to wrap up (the loop's deadline nudge), its work is already
      // persisted (the agent persists in its finally), and it will continue next run. Counting it
      // as a failure would march a healthy long-running task toward auto-pause. See
      // docs/autonomy-loop.md. Bounded tasks keep the old behaviour — there, a timeout more likely
      // means a genuine hang — except that the retry continues the persisted conversation
      // (timedOutRunToResume) instead of starting over.
      if (task.unbounded && /timed out after/.test(errorMsg)) {
        log.info('tasks', `Task ${task.name}: reached its time budget — wrapped up (not a failure)`)
        this.deps.store.update(task.id, {
          lastRunAt: Date.now(),
          runCount: task.runCount + 1,
          consecutiveFailures: 0,
          lastErrorKind: undefined,
        })
        if (task.kind === 'scheduled') {
          this.deps.store.update(task.id, { nextRunAt: this.calculateTaskNextRun(task) })
        }
        const note = '[Reached the round time budget and wrapped up — continues next run.]'
        this.deps.store.completeRun(run.id, { status: 'success', result: note })
        await this.triggerDependents(task.id)
        return { ...run, status: 'success', result: note, completedAt: Date.now() }
      }

      log.warn('tasks', `Task ${task.name} failed: ${errorMsg}`)

      const errorKind = classifyError(errorMsg)
      const failures = task.consecutiveFailures + 1
      const policy = getRetryPolicy(errorKind, failures)

      log.info('tasks', `Task ${task.name}: error classified as ${errorKind} — ${policy.reason}`)

      this.deps.store.update(task.id, {
        lastRunAt: Date.now(),
        consecutiveFailures: failures,
        lastErrorKind: errorKind,
      })

      if (policy.shouldPause) {
        this.deps.store.update(
          task.id,
          { status: 'paused' },
          `${policy.reason} (${errorKind}: ${errorMsg.slice(0, 100)})`,
        )
        await this.notify(
          task,
          `Task "${task.name}" paused: ${policy.reason}\nLast error (${errorKind}): ${errorMsg}`,
        )
      } else if (policy.shouldRetry && task.kind === 'scheduled') {
        const nextRunAt = Date.now() + policy.backoffMs
        this.deps.store.update(task.id, { nextRunAt })
        log.info('tasks', `Task ${task.name}: retrying in ${Math.round(policy.backoffMs / 1000)}s`)
      }

      if (task.notify === 'on_failure' || task.notify === 'always') {
        await this.notify(task, `Task "${task.name}" failed (${errorKind}): ${errorMsg}`)
      }

      this.deps.store.completeRun(run.id, { status: 'failure', error: errorMsg, errorKind })
      return { ...run, status: 'failure', error: errorMsg, errorKind, completedAt: Date.now() }
    } finally {
      deadline.clear()
      // The slot is freed when the execution ends, not when this stops waiting for it. A
      // timed-out run is aborted but lives until its next checkpoint, still writing to the
      // task's transcript; freeing the slot at the timeout let the next tick start a second
      // execution beside it. Model: formal/TaskRunner.tla (OneLiveExecution).
      const release = () => {
        controls?.dispose()
        this.runningCount--
        this.runningTasks.delete(task.id)
        this.repliedDuringRun.delete(task.id)
      }
      execution.then(release, release)
    }
  }

  /** Book a run that finished: reschedule, park, or retire the task as its kind and answer call for. */
  private async recordSuccess(
    task: Task,
    run: TaskRun,
    outcome: Pick<ExecutionOutcome, 'content' | 'awaitingInput' | 'tokensUsed'>,
  ): Promise<TaskRun> {
    const { content: result, awaitingInput, tokensUsed } = outcome
    if (!result.trim()) {
      log.warn(
        'tasks',
        `Task ${task.name} finished with an empty result (${tokensUsed ?? 0} tokens)`,
      )
    }
    const resultHash = await hashString(result)
    const shouldNotify = this.shouldNotify(task, resultHash)

    this.deps.store.update(task.id, {
      lastRunAt: Date.now(),
      runCount: task.runCount + 1,
      consecutiveFailures: 0,
      lastErrorKind: undefined,
      lastResultHash: resultHash,
    })

    if (awaitingInput && this.repliedDuringRun.has(task.id)) {
      // The answer arrived while the run was finishing: run again with it, don't park.
      this.deps.store.update(
        task.id,
        { nextRunAt: Date.now() },
        'Reply arrived during the run — running again instead of parking',
      )
    } else if (awaitingInput) {
      // The run asked its supervisor and no answer came: park instead of rescheduling.
      // The scheduler skips non-active tasks, so the task sits here — visibly distinct
      // from paused/done — until a reply arrives (POST /chat on its session resumes it)
      // or a human resumes it directly. Only an active task parks: one the user paused
      // or retired while it ran keeps that status (model: formal/TaskRunner.tla).
      if (this.deps.store.get(task.id)?.status === 'active') {
        this.deps.store.update(
          task.id,
          { status: 'awaiting' },
          'Parked: report ask went unanswered — awaiting supervisor input',
        )
        // Nothing will move until a human answers, so this is worth interrupting someone for.
        // Deliberately fire-and-forget: a notification that fails must never fail the run.
        try {
          this.deps.onAwaitingInput?.(task)
        } catch {}
      }
    } else if (task.kind === 'scheduled') {
      const nextRunAt = this.calculateTaskNextRun(task)
      this.deps.store.update(task.id, { nextRunAt })
    } else if (task.kind === 'oneshot') {
      // Done with its one run. Left active with its past nextRunAt, the next tick ran it
      // again — for a mailbox task, answering the sender a second time — and it kept counting
      // against maxActiveTasks forever. Only an active task finishes: one the user paused or
      // retired while it ran keeps that status.
      const done = this.deps.store.get(task.id)?.status === 'active'
      this.deps.store.update(
        task.id,
        done ? { nextRunAt: undefined, status: 'done' } : { nextRunAt: undefined },
        done ? 'Oneshot finished' : undefined,
      )
    }

    if (task.maxRuns && task.runCount + 1 >= task.maxRuns) {
      this.deps.store.update(task.id, { status: 'done' }, `Reached max runs (${task.maxRuns})`)
    }

    this.deps.store.completeRun(run.id, { status: 'success', result, tokensUsed })

    if (shouldNotify && result) {
      await this.notify(task, result)
    }

    await this.triggerDependents(task.id)

    return {
      ...run,
      status: 'success',
      result,
      tokensUsed: tokensUsed ?? 0,
      completedAt: Date.now(),
    }
  }

  /**
   * Book a run the agent stopped itself with end_task. done is an ordinary success. blocked
   * completes the run with a [Blocked] result; a oneshot is paused (visible to the operator,
   * not retried) and a scheduled task keeps its schedule. abandoned is a failure with no retry:
   * a oneshot goes to failed, a scheduled task just waits for its next regular run.
   */
  private async recordEnded(
    task: Task,
    run: TaskRun,
    ended: EndRequest,
    tokensUsed?: number,
  ): Promise<TaskRun> {
    if (ended.status === 'done') {
      return this.recordSuccess(task, run, {
        content: ended.summary,
        awaitingInput: false,
        tokensUsed,
      })
    }

    const isActive = this.deps.store.get(task.id)?.status === 'active'
    const nextRunAt = task.kind === 'scheduled' ? this.calculateTaskNextRun(task) : undefined
    const reason = `${ended.status === 'blocked' ? 'Blocked' : 'Abandoned'}: ${ended.summary.slice(0, 200)}`

    if (ended.status === 'blocked') {
      const result = endContent(ended)
      this.deps.store.update(task.id, {
        lastRunAt: Date.now(),
        runCount: task.runCount + 1,
        consecutiveFailures: 0,
        lastErrorKind: undefined,
        nextRunAt,
      })
      if (task.kind === 'oneshot' && isActive) {
        this.deps.store.update(task.id, { status: 'paused' }, reason)
      }
      this.deps.store.completeRun(run.id, { status: 'success', result, tokensUsed })
      if (task.notify !== 'never') await this.notify(task, `Task "${task.name}" ${result}`)
      return {
        ...run,
        status: 'success',
        result,
        tokensUsed: tokensUsed ?? 0,
        completedAt: Date.now(),
      }
    }

    const error = `Abandoned: ${ended.summary}`
    log.warn('tasks', `Task ${task.name}: abandoned by the agent — not retrying`)
    this.deps.store.update(task.id, {
      lastRunAt: Date.now(),
      consecutiveFailures: task.consecutiveFailures + 1,
      lastErrorKind: undefined,
      nextRunAt,
    })
    if (task.kind === 'oneshot' && isActive) {
      this.deps.store.update(task.id, { status: 'failed' }, reason)
    }
    this.deps.store.completeRun(run.id, { status: 'failure', error })
    if (task.notify === 'on_failure' || task.notify === 'always') {
      await this.notify(task, `Task "${task.name}" ${error}`)
    }
    return { ...run, status: 'failure', error, completedAt: Date.now() }
  }

  /** request_extension / end_task for this run: bounded agent runs only. */
  private createControls(task: Task, deadline: RunDeadline): TaskControls | undefined {
    if (task.unbounded || task.name === MAILBOX_TASK_NAME) return undefined
    const cfg = this.deps.tasksConfig
    return createTaskControls({
      sessionId: `task:${task.id}`,
      taskName: task.name,
      deadline,
      extensions: cfg.extensions,
      policy: {
        budgetMs: cfg.taskTimeoutMs,
        maxExtensions: cfg.maxExtensions,
        maxExtensionRatio: cfg.maxExtensionRatio,
      },
      canReport: this.deps.toolExecutor.getDefinitions().some((d) => d.name === 'report'),
    })
  }

  /**
   * Minutes the previous run lasted, when this run should continue it: a bounded task whose
   * last run hit the wall-clock limit and left a persisted conversation to continue. Undefined
   * means a fresh run (the fallback whenever there is nothing to resume from).
   */
  private timedOutRunToResume(task: Task): number | undefined {
    const conversations = this.deps.conversationStore
    if (task.unbounded || !conversations || task.lastErrorKind !== 'timeout') return undefined
    const last = this.deps.store.getRecentRuns(task.id, 1)[0]
    if (!last || last.status !== 'failure' || !/^Task timed out after/.test(last.error ?? '')) {
      return undefined
    }
    if (conversations.loadMessages(`task:${task.id}`).length === 0) return undefined
    const ranMs = (last.completedAt ?? Date.now()) - last.startedAt
    return Math.max(1, Math.round(ranMs / 60_000))
  }

  /**
   * Book a run cut short by shutdown. It did not finish, so it is not a success (a oneshot
   * would go to done with no output and never run again), and it is not the task's failure
   * either: no failure count, no retry policy, no notification. The task is left due again
   * shortly, which the next process to start picks up. Only an active task is re-armed: one
   * the user paused or retired while it ran keeps that status. Until this update the task still
   * carries the claim's lease (or, for runNow, its own schedule), so no other process has
   * started it; the delay keeps one from starting it while this execution winds down.
   */
  private recordInterrupted(task: Task, run: TaskRun): TaskRun {
    const error = 'Interrupted by shutdown'
    log.warn('tasks', `Task ${task.name}: interrupted by shutdown — will run again on restart`)
    if (this.deps.store.get(task.id)?.status === 'active') {
      this.deps.store.update(
        task.id,
        { nextRunAt: Date.now() + SHUTDOWN_REARM_DELAY_MS },
        'Re-armed: run interrupted by shutdown',
      )
    }
    this.deps.store.completeRun(run.id, { status: 'failure', error })
    return { ...run, status: 'failure', error, completedAt: Date.now() }
  }

  /** Trigger tasks that depend on the completed task */
  private async triggerDependents(completedTaskId: string): Promise<void> {
    const dependents = this.deps.store.getDependents(completedTaskId)
    for (const dep of dependents) {
      log.info('tasks', `Triggering dependent task: ${dep.name} (depends on ${completedTaskId})`)
      this.deps.store.update(dep.id, { nextRunAt: Date.now() })
    }
  }

  private async doExecute(task: Task, plan: ExecutionPlan): Promise<ExecutionOutcome> {
    if (task.name === MAILBOX_TASK_NAME) {
      const content = this.deps.pollMailbox
        ? await this.deps.pollMailbox()
        : 'Mailbox is not configured in this process'
      return { content, awaitingInput: false }
    }

    if (task.name === HEARTBEAT_TASK_NAME) {
      const prompt = await heartbeatPreCheck(this.deps.config.workspace.path)
      if (!prompt) {
        return { content: 'No unchecked items in HEARTBEAT.md', awaitingInput: false }
      }
      return this.executePrompt({ ...task, prompt }, plan)
    }

    return this.executePrompt(task, plan)
  }

  /**
   * Read the task's pinned state brief, framed as settled ground truth. Resolved relative to
   * the workspace unless absolute. Missing/unreadable is not an error — the run just proceeds
   * without a pin (logged once). The framing tells the model not to re-derive proven work.
   */
  private loadStateBrief(task: Task, cwd: string): string | undefined {
    if (!task.stateFile) return undefined
    const path = resolveUserPath(task.stateFile, cwd)
    let content: string
    try {
      content = readFileSync(path, 'utf8').trim()
    } catch (err) {
      log.warn('tasks', `state_file ${task.stateFile} not readable, running without pin: ${err}`)
      return undefined
    }
    return formatStateBrief(content, task.stateFile)
  }

  private async executePrompt(task: Task, plan: ExecutionPlan): Promise<ExecutionOutcome> {
    const cwd = this.deps.config.workspace.path
    const standup = await gatherStandup(cwd)

    const contextParts: string[] = []
    if (standup) contextParts.push(standup)

    // Pinned task state. Lives in the system prompt (via additionalContext), so it is present
    // every turn and survives compaction — unlike notes the agent reads with a tool call, whose
    // result gets summarized away mid-run, after which it re-derives already-proven work.
    const pinnedState = this.loadStateBrief(task, cwd)
    if (pinnedState) contextParts.push(pinnedState)

    // The two semantic stops for an unbounded run (docs/autonomy-loop.md): blocked → ask,
    // goal exhausted → report before ending. Only stated when the tool actually exists.
    if (
      task.unbounded &&
      this.deps.toolExecutor.getDefinitions().some((d) => d.name === 'report')
    ) {
      contextParts.push(
        '[This is an unbounded run. If you become blocked on a decision you cannot make yourself, use report (mode=ask) instead of guessing. If your goal is exhausted, report what you accomplished (mode=ask for direction, or mode=notify then end the run). Being blocked is a signal to report, not a failure.]',
      )
    }

    if (this.deps.memory && task.memoryContext) {
      for (const key of task.memoryContext) {
        const entry = this.deps.memory.get(key)
        if (entry) {
          contextParts.push(`[Memory: ${key}] ${entry.value}`)
        }
      }
    }

    if (this.deps.memory) {
      const retrievalConfig = {
        scoreThreshold: this.deps.config.memory?.scoreThreshold ?? 0.35,
        maxResults: this.deps.config.memory?.maxResults ?? 5,
        maxTokensBudget: this.deps.config.memory?.maxTokensBudget ?? 2000,
      }
      const recalled = await retrieveForContext(task.prompt, this.deps.memory, retrievalConfig)
      if (recalled) contextParts.push(recalled)
    }

    const sessionId = `task:${task.id}`
    const deps: AgentLoopDeps = {
      config: this.deps.config,
      toolExecutor: this.deps.toolExecutor,
      localProvider: this.deps.localProvider,
      auxProvider: this.deps.auxProvider,
      sessionId,
      memory: this.deps.memory,
      conversationStore: this.taskConversationStore(task, sessionId, plan),
      additionalContext: `${TASK_SYSTEM_PROMPT}\n\nTask: ${task.description}\n\n${contextParts.join('\n\n')}`,
      sessionMutex: this.deps.sessionMutex,
    }

    const agent = new AgentLoop(deps)
    // A run continuing one that hit its time limit opens on the resume note, not the prompt
    // again: the prompt and everything the first run did are already in the conversation.
    const message =
      plan.resumeAfterMinutes !== undefined
        ? timeoutResumeNudge(plan.resumeAfterMinutes)
        : task.prompt
    if (plan.resumeAfterMinutes !== undefined) {
      log.info('tasks', `Task ${task.name}: resuming the run that hit its time limit`)
    }
    const response = await agent.run(message, {
      maxTurns: task.maxTurns ?? 10,
      unbounded: task.unbounded,
      // An unbounded run is the autonomy loop proper: its state lives in NOTES/work by
      // contract, so its context is disposable — recycle it from notes rather than summarize.
      ...(task.unbounded && { contextRollover: true }),
      // consolidationInterval falls through to the instance config default in the loop.
      signal: plan.signal,
      // Deadline drives the loop's wrap-up warning so the agent winds down before the hard
      // timeout aborts it. Wrap-up is offered on every task; the not-a-failure treatment of an
      // over-run is unbounded-only (in executeTask's catch). It is a function: an extension
      // moves it.
      deadline: plan.deadline,
      wrapupMarginMs: plan.wrapupMarginMs,
      ...(plan.extraTools && { extraTools: plan.extraTools }),
    })

    if (this.deps.memory) {
      const storeMemory = this.deps.memory
      const taskId = task.id
      const taskName = task.name

      extractMemories(
        [
          { role: 'user', content: task.prompt },
          { role: 'assistant', content: response.content },
        ],
        this.deps.localProvider,
        { minMessages: 1, maxExtractions: 3 },
      )
        .then(async (extractions) => {
          for (const ext of extractions) {
            await storeMemory.set(`auto/task/${taskName}/${ext.key}`, ext.value, {
              category: ext.category,
              source: 'auto',
              sessionId: `task:${taskId}`,
            })
          }
        })
        .catch((err) => log.warn('tasks', `Auto-extraction failed for task ${taskId}: ${err}`))

      extractLessonsFromTask(
        taskName,
        task.prompt,
        response.content,
        false,
        this.deps.localProvider,
      )
        .then(async (lessons) => {
          for (const lesson of lessons) {
            await storeMemory.set(`lesson/task/${taskName}/${lesson.key}`, lesson.value, {
              category: 'lesson',
              source: 'auto',
              sessionId: `task:${taskId}`,
            })
          }
          if (lessons.length > 0) {
            log.info('tasks', `Stored ${lessons.length} lesson(s) from task ${taskName}`)
          }
        })
        .catch((err) => log.warn('tasks', `Lesson extraction failed for task ${taskId}: ${err}`))
    }

    // Post-run self-review: a restricted fork of the agent (skill/memory tools only) reviews
    // the run digest and updates skills/memory. Unbounded tasks only — a bounded check-in
    // task rarely develops procedures — and fire-and-forget: reviews never block the runner.
    if (task.unbounded && this.deps.tasksConfig.selfReview) {
      runSelfReview(task.id, task.name, agent.getContext().messages, {
        config: this.deps.config,
        provider: this.deps.localProvider,
        memory: this.deps.memory,
      }).catch((err) => log.warn('tasks', `Self-review failed for ${task.name}: ${err}`))
    }

    return {
      content: response.content,
      awaitingInput: response.awaitingInput === true,
      aborted: response.aborted === true,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
    }
  }

  /**
   * Where a task run's conversation is kept. A bounded run always persists when a store exists,
   * so a run that hits its time limit can be continued instead of redone; without
   * persist_conversation, a fresh run first clears the previous run's transcript so it still
   * starts clean. Unbounded runs keep their own setting.
   */
  private taskConversationStore(
    task: Task,
    sessionId: string,
    plan: ExecutionPlan,
  ): ConversationStore | undefined {
    const store = this.deps.conversationStore
    if (!store) return undefined
    if (task.persistConversation) return store
    if (task.unbounded) return undefined
    if (plan.resumeAfterMinutes === undefined) store.deleteSession(sessionId)
    return store
  }

  private shouldNotify(task: Task, resultHash: string): boolean {
    switch (task.notify) {
      case 'always':
        return true
      case 'never':
        return false
      case 'on_change':
        return task.lastResultHash !== resultHash
      case 'on_failure':
        return false
      default:
        return task.lastResultHash !== resultHash
    }
  }

  private async notify(task: Task, message: string): Promise<void> {
    const channel = this.deps.outbound.get(task.channel)
    if (!channel) {
      log.warn('tasks', `No outbound channel "${task.channel}" for task ${task.name}`)
      return
    }
    try {
      await channel.send(task.channelTarget, message)
    } catch (err) {
      log.error('tasks', `Failed to send notification for ${task.name}: ${err}`)
    }
  }
}

async function hashString(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  return new TaskRunner(deps)
}
