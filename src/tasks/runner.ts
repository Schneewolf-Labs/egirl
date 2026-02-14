import { log } from '../util/logger'
import { gatherStandup } from '../standup'
import { retrieveForContext } from '../memory/retrieval'
import { extractMemories } from '../memory/extractor'
import { executeWorkflow } from '../workflows/engine'
import { AgentLoop } from '../agent/loop'
import { parseScheduleExpression, nextOccurrence } from './cron'
import { calculateNextRun, parseBusinessHours, isWithinBusinessHours } from './schedule'
import { classifyError, getRetryPolicy } from './error-classify'
import type { AgentLoopDeps } from '../agent/loop'
import type { WorkflowDefinition } from '../workflows/types'
import type { MemoryManager } from '../memory'
import type { RuntimeConfig } from '../config'
import type { Router } from '../routing'
import type { ToolExecutor } from '../tools'
import type { LLMProvider } from '../providers/types'
import type { TaskStore } from './store'
import type {
  Task,
  TaskRun,
  TasksConfig,
  EventPayload,
  EventSource,
} from './types'
import { createFileWatcher, type FileWatchConfig } from './events/file-watcher'
import { createGitHubEventSource, type GitHubEventConfig } from './events/github'
import { createCommandSource, type CommandEventConfig } from './events/command'
import { createWebhookSource, type WebhookConfig, type WebhookRouter } from './events/webhook'

const TASK_SYSTEM_PROMPT = `You are executing a background task. Be concise and focused.
Use memory tools to store any findings worth remembering across runs.
Use memory_recall for temporal context (e.g. "what happened last run").
If you need context from previous runs, use memory_search.`

interface QueuedEvent {
  taskId: string
  payload: EventPayload
  queuedAt: number
}

export interface OutboundChannel {
  send(target: string, message: string): Promise<void>
}

export interface TaskRunnerDeps {
  config: RuntimeConfig
  tasksConfig: TasksConfig
  store: TaskStore
  toolExecutor: ToolExecutor
  router: Router
  localProvider: LLMProvider
  remoteProvider: LLMProvider | null
  memory: MemoryManager | undefined
  outbound: Map<string, OutboundChannel>
  webhookRouter?: WebhookRouter
}

export class TaskRunner {
  private deps: TaskRunnerDeps
  private tickTimer: ReturnType<typeof setInterval> | undefined
  private eventSources: Map<string, EventSource> = new Map()
  private eventQueue: QueuedEvent[] = []
  private isExecuting = false
  private currentTaskId: string | undefined
  private abortController: AbortController | undefined
  private lastInteractionAt: number = Date.now()
  /** Track last event timestamp per task for deduplication */
  private lastEventAt: Map<string, number> = new Map()
  /** Minimum ms between event-triggered runs for same task */
  private eventDedupeMs = 10_000

  constructor(deps: TaskRunnerDeps) {
    this.deps = deps
  }

  start(): void {
    const { tickIntervalMs } = this.deps.tasksConfig
    this.tickTimer = setInterval(() => this.tick(), tickIntervalMs)

    // Register event sources for all active event-driven tasks
    const eventTasks = this.deps.store.getEventTasks()
    for (const task of eventTasks) {
      this.registerEventSource(task)
    }

    log.info('tasks', `Task runner started (tick=${tickIntervalMs}ms, ${eventTasks.length} event sources)`)
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = undefined

    for (const [id, source] of this.eventSources) {
      source.stop()
      log.debug('tasks', `Stopped event source: ${id}`)
    }
    this.eventSources.clear()

    if (this.abortController) {
      this.abortController.abort()
    }

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
    return !this.isExecuting
  }

  getCurrentTaskId(): string | undefined {
    return this.currentTaskId
  }

  /** Activate a task — start event sources if event-driven, set next_run for scheduled */
  activateTask(taskId: string): void {
    const task = this.deps.store.get(taskId)
    if (!task) return

    if (task.kind === 'event') {
      this.registerEventSource(task)
    }
    if (task.kind === 'scheduled') {
      const nextRunAt = this.calculateTaskNextRun(task)
      this.deps.store.update(taskId, { nextRunAt })
    }
    if (task.kind === 'oneshot') {
      this.deps.store.update(taskId, { nextRunAt: Date.now() })
    }
  }

  /** Deactivate a task — stop event sources, clear scheduling */
  deactivateTask(taskId: string): void {
    this.unregisterEventSource(taskId)
  }

  /** Trigger a task immediately regardless of schedule */
  async runNow(taskId: string): Promise<TaskRun | undefined> {
    const task = this.deps.store.get(taskId)
    if (!task) return undefined
    return this.executeTask(task)
  }

  private calculateTaskNextRun(task: Task, now?: Date): number {
    const currentTime = now ?? new Date()

    // Parse business hours if configured
    const businessHours = task.businessHours
      ? parseBusinessHours(task.businessHours)
      : undefined

    // Cron expression takes precedence over interval
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

    // Fall back to interval
    return calculateNextRun({
      intervalMs: task.intervalMs,
      businessHours,
      now: currentTime,
    })
  }

  private async tick(): Promise<void> {
    if (this.isExecuting) return

    // Process queued events first (deduplicated)
    if (this.eventQueue.length > 0) {
      const event = this.eventQueue.shift()!
      const task = this.deps.store.get(event.taskId)
      if (task && task.status === 'active') {
        await this.executeTask(task, event.payload)
      }
      return
    }

    // Check for due scheduled/oneshot tasks
    const due = this.deps.store.getDueTasks(Date.now())
    for (const task of due) {
      // Check business hours constraint before running
      if (task.businessHours) {
        const hours = parseBusinessHours(task.businessHours)
        if (hours && !isWithinBusinessHours(new Date(), hours)) {
          // Reschedule to next business hours window
          const nextRunAt = this.calculateTaskNextRun(task)
          this.deps.store.update(task.id, { nextRunAt })
          continue
        }
      }

      await this.executeTask(task)
      return // One task per tick
    }
  }

  private registerEventSource(task: Task): void {
    if (this.eventSources.has(task.id)) return
    if (!task.eventSource || !task.eventConfig) {
      log.warn('tasks', `Task ${task.id} has kind=event but no event_source/event_config`)
      return
    }

    const cwd = this.deps.config.workspace.path
    let source: EventSource | undefined

    switch (task.eventSource) {
      case 'file':
        source = createFileWatcher(task.eventConfig as FileWatchConfig, cwd)
        break
      case 'github':
        source = createGitHubEventSource(
          task.eventConfig as GitHubEventConfig,
          this.deps.toolExecutor,
          cwd,
        )
        break
      case 'command':
        source = createCommandSource(task.eventConfig as CommandEventConfig, cwd)
        break
      case 'webhook':
        if (!this.deps.webhookRouter) {
          log.warn('tasks', `Webhook tasks require the API server. Task ${task.id} cannot activate.`)
          return
        }
        source = createWebhookSource(
          task.eventConfig as WebhookConfig,
          this.deps.webhookRouter,
        )
        break
    }

    if (!source) return

    source.start((payload) => {
      // Deduplicate: skip if we got an event for this task within dedupeMs
      const now = Date.now()
      const lastEvent = this.lastEventAt.get(task.id) ?? 0
      if (now - lastEvent < this.eventDedupeMs) {
        log.debug('tasks', `Deduplicating event for task ${task.id} (${now - lastEvent}ms since last)`)
        return
      }
      this.lastEventAt.set(task.id, now)

      // If currently executing, queue it (keep only latest per task)
      if (this.isExecuting) {
        this.eventQueue = this.eventQueue.filter(e => e.taskId !== task.id)
        this.eventQueue.push({ taskId: task.id, payload, queuedAt: now })
        return
      }

      const t = this.deps.store.get(task.id)
      if (t && t.status === 'active') {
        this.executeTask(t, payload).catch(err =>
          log.error('tasks', `Event-triggered execution failed for ${task.id}: ${err}`)
        )
      }
    })

    this.eventSources.set(task.id, source)
    log.debug('tasks', `Registered event source for task ${task.id} (${task.eventSource})`)
  }

  private unregisterEventSource(taskId: string): void {
    const source = this.eventSources.get(taskId)
    if (source) {
      source.stop()
      this.eventSources.delete(taskId)
    }
    this.lastEventAt.delete(taskId)
  }

  private async executeTask(task: Task, eventPayload?: EventPayload): Promise<TaskRun> {
    this.isExecuting = true
    this.currentTaskId = task.id
    this.abortController = new AbortController()

    const run = this.deps.store.createRun(task.id, eventPayload)
    const timeoutMs = this.deps.tasksConfig.taskTimeoutMs

    log.info('tasks', `Executing task: ${task.name} (${task.id})`)

    try {
      const result = await Promise.race([
        this.doExecute(task, eventPayload),
        this.timeout(timeoutMs),
      ])

      const resultHash = await hashString(result)

      // Check notification criteria
      const shouldNotify = this.shouldNotify(task, resultHash, result)

      // Update task state — clear failure tracking on success
      this.deps.store.update(task.id, {
        lastRunAt: Date.now(),
        runCount: task.runCount + 1,
        consecutiveFailures: 0,
        lastErrorKind: undefined,
        lastResultHash: resultHash,
      })

      // Schedule next run for scheduled tasks
      if (task.kind === 'scheduled') {
        const nextRunAt = this.calculateTaskNextRun(task)
        this.deps.store.update(task.id, { nextRunAt })
      }

      // Check max_runs
      if (task.maxRuns && task.runCount + 1 >= task.maxRuns) {
        this.deps.store.update(task.id, { status: 'done' })
        this.unregisterEventSource(task.id)
      }

      // Complete the run
      this.deps.store.completeRun(run.id, { status: 'success', result })

      // Notify if criteria met
      if (shouldNotify && result) {
        await this.notify(task, result)
      }

      // Trigger dependent tasks
      await this.triggerDependents(task.id)

      return { ...run, status: 'success', result, completedAt: Date.now() }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log.warn('tasks', `Task ${task.name} failed: ${errorMsg}`)

      // Classify the error
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
        this.deps.store.update(task.id, { status: 'paused' })
        this.unregisterEventSource(task.id)
        await this.notify(
          task,
          `Task "${task.name}" paused: ${policy.reason}\nLast error (${errorKind}): ${errorMsg}`,
        )
      } else if (policy.shouldRetry && task.kind === 'scheduled') {
        // Schedule retry with backoff
        const nextRunAt = Date.now() + policy.backoffMs
        this.deps.store.update(task.id, { nextRunAt })
        log.info('tasks', `Task ${task.name}: retrying in ${Math.round(policy.backoffMs / 1000)}s`)
      }

      // Notify on failure if configured
      if (task.notify === 'on_failure' || task.notify === 'always') {
        await this.notify(task, `Task "${task.name}" failed (${errorKind}): ${errorMsg}`)
      }

      this.deps.store.completeRun(run.id, { status: 'failure', error: errorMsg, errorKind })
      return { ...run, status: 'failure', error: errorMsg, errorKind, completedAt: Date.now() }
    } finally {
      this.isExecuting = false
      this.currentTaskId = undefined
      this.abortController = undefined
    }
  }

  /** Trigger tasks that depend on the completed task */
  private async triggerDependents(completedTaskId: string): Promise<void> {
    const dependents = this.deps.store.getDependents(completedTaskId)
    for (const dep of dependents) {
      log.info('tasks', `Triggering dependent task: ${dep.name} (depends on ${completedTaskId})`)

      // For scheduled dependents, set them to run now
      if (dep.kind === 'scheduled' || dep.kind === 'oneshot') {
        this.deps.store.update(dep.id, { nextRunAt: Date.now() })
      }
      // For event dependents, queue a synthetic event
      if (dep.kind === 'event') {
        this.eventQueue.push({
          taskId: dep.id,
          payload: {
            source: 'command',
            summary: `Triggered by completion of task ${completedTaskId}`,
            data: { triggeredBy: completedTaskId },
          },
          queuedAt: Date.now(),
        })
      }
    }
  }

  private async doExecute(task: Task, eventPayload?: EventPayload): Promise<string> {
    // If task has a workflow definition, try workflow-first execution
    if (task.workflow) {
      const workflowResult = await this.executeWorkflow(task)

      // Hybrid mode: if workflow failed and there's a prompt, fall through to agent
      if (!workflowResult.success && task.prompt) {
        const context = `Workflow "${workflowResult.workflow}" failed.\n\nStep results:\n${workflowResult.output}`
        return this.executePrompt(task, eventPayload, context)
      }

      return workflowResult.output
    }

    // Prompt-based execution
    return this.executePrompt(task, eventPayload)
  }

  private async executeWorkflow(task: Task): Promise<{ success: boolean; workflow: string; output: string }> {
    const cwd = this.deps.config.workspace.path
    const def = task.workflow as { name?: string; steps?: unknown[]; params?: Record<string, unknown> }

    const definition: WorkflowDefinition = {
      name: def.name ?? task.name,
      description: task.description,
      steps: (def.steps ?? []) as WorkflowDefinition['steps'],
      params: {},
    }

    const result = await executeWorkflow(
      definition,
      def.params ?? {},
      this.deps.toolExecutor,
      cwd,
    )

    return {
      success: result.success,
      workflow: result.workflow,
      output: result.output,
    }
  }

  private async executePrompt(
    task: Task,
    eventPayload?: EventPayload,
    additionalContext?: string,
  ): Promise<string> {
    const cwd = this.deps.config.workspace.path

    // Gather workspace context
    const standup = await gatherStandup(cwd)

    // Build additional context
    const contextParts: string[] = []
    if (standup.context) contextParts.push(standup.context)

    // Pre-load memory context
    if (this.deps.memory && task.memoryContext) {
      for (const key of task.memoryContext) {
        const entry = this.deps.memory.get(key)
        if (entry) {
          contextParts.push(`[Memory: ${key}] ${entry.value}`)
        }
      }
    }

    // Proactive memory retrieval
    if (this.deps.memory) {
      const recalled = await retrieveForContext(task.prompt, this.deps.memory, {
        scoreThreshold: this.deps.config.memory?.scoreThreshold ?? 0.35,
        maxResults: this.deps.config.memory?.maxResults ?? 5,
        maxTokensBudget: this.deps.config.memory?.maxTokensBudget ?? 2000,
      })
      if (recalled) contextParts.push(recalled)
    }

    if (additionalContext) contextParts.push(additionalContext)

    // Build the user message
    let userMessage = task.prompt
    if (eventPayload) {
      const eventData = typeof eventPayload.data === 'string'
        ? eventPayload.data
        : JSON.stringify(eventPayload.data, null, 2)
      userMessage = `[Event: ${eventPayload.summary}]\n${eventData}\n\n${task.prompt}`
    }

    // Create a scoped AgentLoop
    const deps: AgentLoopDeps = {
      config: this.deps.config,
      router: this.deps.router,
      toolExecutor: this.deps.toolExecutor,
      localProvider: this.deps.localProvider,
      remoteProvider: this.deps.remoteProvider,
      sessionId: `task:${task.id}`,
      memory: this.deps.memory,
      // No conversation store — task conversations are ephemeral
      additionalContext: `${TASK_SYSTEM_PROMPT}\n\nTask: ${task.description}\n\n${contextParts.join('\n\n')}`,
    }

    const agent = new AgentLoop(deps)
    const response = await agent.run(userMessage, { maxTurns: 10 })

    // Fire-and-forget auto-extraction
    if (this.deps.memory) {
      extractMemories(
        [
          { role: 'user', content: userMessage },
          { role: 'assistant', content: response.content },
        ],
        this.deps.localProvider,
        { minMessages: 1, maxExtractions: 3 },
      ).then(async (extractions) => {
        for (const ext of extractions) {
          await this.deps.memory!.set(`auto/task/${task.name}/${ext.key}`, ext.value, {
            category: ext.category,
            source: 'auto',
            sessionId: `task:${task.id}`,
          })
        }
      }).catch(err => log.warn('tasks', `Auto-extraction failed for task ${task.id}: ${err}`))
    }

    return response.content
  }

  private shouldNotify(task: Task, resultHash: string, result: string): boolean {
    switch (task.notify) {
      case 'always': return true
      case 'never': return false
      case 'on_change': return task.lastResultHash !== resultHash
      case 'on_failure': return false // failures are handled in the catch block
      default: return task.lastResultHash !== resultHash
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
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16) // Short hash is fine for diffing
}

export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  return new TaskRunner(deps)
}
