import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { AgentLoop } from '../agent/loop'
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
import { log } from '../util/logger'
import { parseScheduleExpression } from './cron'
import { classifyError, getRetryPolicy } from './error-classify'
import { HEARTBEAT_TASK_NAME, heartbeatPreCheck } from './heartbeat'
import { calculateNextRun, isWithinBusinessHours, parseBusinessHours } from './schedule'
import { runSelfReview } from './self-review'
import type { TaskStore } from './store'
import type { Task, TaskRun, TasksConfig } from './types'

const TASK_SYSTEM_PROMPT = `You are executing a background task. Be concise and focused.
Use memory tools to store any findings worth remembering across runs.
Use memory_recall for temporal context (e.g. "what happened last run").
If you need context from previous runs, use memory_search.`

/** Upper bound on the pinned state brief (~4k tokens). The DONE ledger belongs here; deep
 * history stays in the agent's own notes, read on demand. Truncated head keeps the ledger,
 * which by convention sits at the top of the file. */
const MAX_STATE_BRIEF_CHARS = 16000

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
}

export class TaskRunner {
  private deps: TaskRunnerDeps
  private tickTimer: ReturnType<typeof setInterval> | undefined
  private runningCount = 0
  private runningTasks: Map<string, { controller: AbortController }> = new Map()
  private lastInteractionAt: number = Date.now()

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
    const { tickIntervalMs } = this.deps.tasksConfig
    this.tickTimer = setInterval(() => this.tick(), tickIntervalMs)
    log.info('tasks', `Task runner started (tick=${tickIntervalMs}ms)`)
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = undefined

    for (const [, entry] of this.runningTasks) {
      entry.controller.abort()
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

  /** Trigger a task immediately regardless of schedule */
  async runNow(taskId: string): Promise<TaskRun | undefined> {
    const task = this.deps.store.get(taskId)
    if (!task) return undefined
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

      this.executeTask(task).catch((err) =>
        log.error('tasks', `Scheduled task ${task.id} failed: ${err}`),
      )
    }
  }

  private async executeTask(task: Task): Promise<TaskRun> {
    this.runningCount++
    const abortController = new AbortController()
    this.runningTasks.set(task.id, { controller: abortController })

    const run = this.deps.store.createRun(task.id)
    const timeoutMs = this.deps.tasksConfig.taskTimeoutMs
    const signal = abortController.signal
    // The wall-clock instant this run will be hard-aborted, and how long before it the agent
    // is warned to wrap up. The margin scales with the budget so a longer round gets a longer
    // wind-down, capped so it never eats most of a short one.
    const deadline = Date.now() + timeoutMs
    const wrapupMarginMs = Math.min(Math.round(timeoutMs * 0.15), 10 * 60_000)

    const timeoutId = setTimeout(() => abortController.abort('timeout'), timeoutMs)

    log.info('tasks', `Executing task: ${task.name} (${task.id})`)

    try {
      const { content: result, awaitingInput } = await Promise.race([
        this.doExecute(task, signal, deadline, wrapupMarginMs),
        this.timeout(timeoutMs),
      ])
      const resultHash = await hashString(result)
      const shouldNotify = this.shouldNotify(task, resultHash)

      this.deps.store.update(task.id, {
        lastRunAt: Date.now(),
        runCount: task.runCount + 1,
        consecutiveFailures: 0,
        lastErrorKind: undefined,
        lastResultHash: resultHash,
      })

      if (awaitingInput) {
        // The run asked its supervisor and no answer came: park instead of rescheduling.
        // The scheduler skips non-active tasks, so the task sits here — visibly distinct
        // from paused/done — until a reply arrives (POST /chat on its session resumes it)
        // or a human resumes it directly.
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
      } else if (task.kind === 'scheduled') {
        const nextRunAt = this.calculateTaskNextRun(task)
        this.deps.store.update(task.id, { nextRunAt })
      }

      if (task.maxRuns && task.runCount + 1 >= task.maxRuns) {
        this.deps.store.update(task.id, { status: 'done' }, `Reached max runs (${task.maxRuns})`)
      }

      this.deps.store.completeRun(run.id, { status: 'success', result })

      if (shouldNotify && result) {
        await this.notify(task, result)
      }

      await this.triggerDependents(task.id)

      return { ...run, status: 'success', result, completedAt: Date.now() }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)

      // An unbounded run reaching its wall-clock time budget is a scheduled checkpoint boundary,
      // not a failure. It was warned to wrap up (the loop's deadline nudge), its work is already
      // persisted (the agent persists in its finally), and it will continue next run. Counting it
      // as a failure would march a healthy long-running task toward auto-pause. See
      // docs/autonomy-loop.md. Bounded tasks keep the old behaviour — there, a timeout more likely
      // means a genuine hang.
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
      clearTimeout(timeoutId)
      this.runningCount--
      this.runningTasks.delete(task.id)
    }
  }

  /** Trigger tasks that depend on the completed task */
  private async triggerDependents(completedTaskId: string): Promise<void> {
    const dependents = this.deps.store.getDependents(completedTaskId)
    for (const dep of dependents) {
      log.info('tasks', `Triggering dependent task: ${dep.name} (depends on ${completedTaskId})`)
      this.deps.store.update(dep.id, { nextRunAt: Date.now() })
    }
  }

  private async doExecute(
    task: Task,
    signal: AbortSignal | undefined,
    deadline: number,
    wrapupMarginMs: number,
  ): Promise<{ content: string; awaitingInput: boolean }> {
    if (task.name === HEARTBEAT_TASK_NAME) {
      const prompt = await heartbeatPreCheck(this.deps.config.workspace.path)
      if (!prompt) {
        return { content: 'No unchecked items in HEARTBEAT.md', awaitingInput: false }
      }
      return this.executePrompt({ ...task, prompt }, signal, deadline, wrapupMarginMs)
    }

    return this.executePrompt(task, signal, deadline, wrapupMarginMs)
  }

  /**
   * Read the task's pinned state brief, framed as settled ground truth. Resolved relative to
   * the workspace unless absolute. Missing/unreadable is not an error — the run just proceeds
   * without a pin (logged once). The framing tells the model not to re-derive proven work.
   */
  private loadStateBrief(task: Task, cwd: string): string | undefined {
    if (!task.stateFile) return undefined
    const path = isAbsolute(task.stateFile) ? task.stateFile : resolve(cwd, task.stateFile)
    let content: string
    try {
      content = readFileSync(path, 'utf8').trim()
    } catch (err) {
      log.warn('tasks', `state_file ${task.stateFile} not readable, running without pin: ${err}`)
      return undefined
    }
    return formatStateBrief(content, task.stateFile)
  }

  private async executePrompt(
    task: Task,
    signal?: AbortSignal,
    deadline?: number,
    wrapupMarginMs?: number,
  ): Promise<{ content: string; awaitingInput: boolean }> {
    const cwd = this.deps.config.workspace.path
    const standup = await gatherStandup(cwd)

    const contextParts: string[] = []
    if (standup.context) contextParts.push(standup.context)

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

    const deps: AgentLoopDeps = {
      config: this.deps.config,
      toolExecutor: this.deps.toolExecutor,
      localProvider: this.deps.localProvider,
      auxProvider: this.deps.auxProvider,
      sessionId: `task:${task.id}`,
      memory: this.deps.memory,
      conversationStore:
        task.persistConversation && this.deps.conversationStore
          ? this.deps.conversationStore
          : undefined,
      additionalContext: `${TASK_SYSTEM_PROMPT}\n\nTask: ${task.description}\n\n${contextParts.join('\n\n')}`,
      sessionMutex: this.deps.sessionMutex,
    }

    const agent = new AgentLoop(deps)
    const response = await agent.run(task.prompt, {
      maxTurns: task.maxTurns ?? 10,
      unbounded: task.unbounded,
      // An unbounded run is the autonomy loop proper: its state lives in NOTES/work by
      // contract, so its context is disposable — recycle it from notes rather than summarize.
      ...(task.unbounded && { contextRollover: true }),
      // consolidationInterval falls through to the instance config default in the loop.
      signal,
      // Deadline drives the loop's wrap-up warning so the agent winds down before the hard
      // timeout aborts it. Wrap-up is offered on every task; the not-a-failure treatment of an
      // over-run is unbounded-only (in executeTask's catch).
      ...(deadline !== undefined && { deadline }),
      ...(wrapupMarginMs !== undefined && { wrapupMarginMs }),
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

    return { content: response.content, awaitingInput: response.awaitingInput === true }
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

  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Task timed out after ${ms}ms`)), ms)
    })
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
