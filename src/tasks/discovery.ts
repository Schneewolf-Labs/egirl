import { AgentLoop } from '../agent/loop'
import type { AgentLoopDeps } from '../agent/types'
import type { RuntimeConfig } from '../config'
import type { MemoryManager } from '../memory'
import { retrieveForContext } from '../memory/retrieval'
import type { OperatorBuilder } from '../operator'
import type { LLMProvider } from '../providers/types'
import { gatherStandup } from '../standup'
import type { ToolExecutor } from '../tools'
import { createToolExecutor } from '../tools/executor'
import { log } from '../util/logger'
import { formatInterval } from './parse-interval'
import type { TaskRunner } from './runner'
import type { TaskStore } from './store'
import type { TasksConfig } from './types'

// 5 ran out before the proposal in nearly every pass (Jaeger: 47 of 47 at the cap).
const DISCOVERY_MAX_TURNS = 10

/**
 * What a pass may use: looking, and proposing. It runs unattended while the principal is away,
 * and with the whole toolbelt Jaeger's passes ran 131 shell commands, cancelled four tasks and
 * wrote memory in two days -- decisions that are the principal's, not a background sweep's.
 * Read-only tools plus task_propose; anything else it wants done, it proposes.
 */
export const DISCOVERY_TOOLS = [
  'read_file',
  'glob_files',
  'git_status',
  'git_log',
  'git_diff',
  'git_show',
  'git_pr_state',
  'gh_ci_status',
  'gh_pr_list',
  'gh_pr_view',
  'gh_issue_list',
  'gh_issue_view',
  'gh_release_list',
  'memory_search',
  'memory_recall',
  'memory_get',
  'memory_list',
  'session_search',
  'skill_read',
  'task_list',
  'task_history',
  'task_propose',
]

/** Proposals waiting for review at which a pass is skipped: one pass's worth, still unread. */
const MAX_WAITING_PROPOSALS = 3

/** The instance's own tools, cut down to the ones a discovery pass may use. */
export function discoveryExecutor(full: ToolExecutor): ToolExecutor {
  const executor = createToolExecutor()
  for (const name of DISCOVERY_TOOLS) {
    const tool = full.get(name)
    if (tool) executor.register(tool)
  }
  return executor
}

const DISCOVERY_PROMPT = `Based on the workspace and memory context below, is there any useful background work worth proposing?

Consider:
- CI status — are there failing checks or stale pipelines?
- Open PRs — anything waiting for review, or reviews you could watch?
- Pending TODOs mentioned in recent conversations
- Files or branches being actively worked on
- Anything the user seemed to be waiting on

Use memory_search and memory_recall to check for relevant context you might be missing.

Rules:
- Only propose genuinely useful work — don't make work for the sake of it
- Use task_propose for each suggestion (max 3)
- Each proposal needs a clear reason why it's useful
- If nothing is worth proposing, just say "No useful work to propose" and stop`

export interface DiscoveryDeps {
  config: RuntimeConfig
  tasksConfig: TasksConfig
  store: TaskStore
  runner: TaskRunner
  toolExecutor: ToolExecutor
  localProvider: LLMProvider
  auxProvider?: LLMProvider
  memory: MemoryManager | undefined
  /** Builds the operator a pass drives: the instance's own kind. Absent = the local loop. */
  buildOperator?: OperatorBuilder
}

export class Discovery {
  private deps: DiscoveryDeps
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(deps: DiscoveryDeps) {
    this.deps = deps
  }

  start(): void {
    const interval = this.deps.tasksConfig.discoveryIntervalMs
    this.timer = setInterval(() => this.maybeRun(), interval)
    log.debug('tasks', `Discovery started (interval=${formatInterval(interval)})`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    log.info('tasks', 'Discovery stopped')
  }

  /** Check conditions and run discovery if appropriate */
  private async maybeRun(): Promise<void> {
    // Don't run if task runner is busy
    if (!this.deps.runner.isIdle()) {
      log.debug('tasks', 'Discovery skipped: runner busy')
      return
    }

    // Don't run if user hasn't been active in the last 2 hours
    const lastInteraction = this.deps.runner.getLastInteractionAt()
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
    if (lastInteraction < twoHoursAgo) {
      log.debug('tasks', 'Discovery skipped: user not present')
      return
    }

    // Proposals nobody has looked at yet: more of them would only pile up.
    const waiting = this.deps.store.list({ status: 'proposed' }).length
    if (waiting >= MAX_WAITING_PROPOSALS) {
      log.debug('tasks', `Discovery skipped: ${waiting} proposals already waiting for review`)
      return
    }

    // Don't run if idle threshold not met
    const idleMs = Date.now() - lastInteraction
    if (idleMs < this.deps.tasksConfig.idleThresholdMs) {
      log.debug('tasks', 'Discovery skipped: not idle long enough')
      return
    }

    await this.run()
  }

  /** Run discovery — always uses local model */
  async run(): Promise<void> {
    log.debug('tasks', 'Running discovery')

    try {
      const cwd = this.deps.config.workspace.path

      // Gather workspace context
      const standup = await gatherStandup(cwd)

      // Get active tasks for context
      const activeTasks = this.deps.store.list({ status: 'active' })
      const tasksSummary =
        activeTasks.length > 0
          ? `Active tasks:\n${activeTasks.map((t) => `- ${t.name}: ${t.description}`).join('\n')}`
          : 'No active background tasks.'

      // Proactive memory retrieval
      const contextParts: string[] = []
      if (standup) contextParts.push(standup)
      contextParts.push(tasksSummary)

      if (this.deps.memory) {
        const recalled = await retrieveForContext(
          'recent project context, pending work, open items',
          this.deps.memory,
          { scoreThreshold: 0.3, maxResults: 5, maxTokensBudget: 1500 },
        )
        if (recalled) contextParts.push(recalled)
      }

      const agentDeps: AgentLoopDeps = {
        config: this.deps.config,
        toolExecutor: discoveryExecutor(this.deps.toolExecutor),
        localProvider: this.deps.localProvider,
        auxProvider: this.deps.auxProvider,
        sessionId: 'discovery',
        memory: this.deps.memory,
        additionalContext: contextParts.join('\n\n'),
      }

      // Every pass starts clean: discovery keeps no transcript of its own.
      const agent =
        this.deps.buildOperator?.({ ...agentDeps, isFresh: true }) ?? new AgentLoop(agentDeps)
      const before = this.deps.store.list({ status: 'proposed' }).length
      const result = await agent.run(DISCOVERY_PROMPT, {
        maxTurns: DISCOVERY_MAX_TURNS,
        // A fixed prompt: the pass already gathered its own recall into additionalContext.
        isHarnessTurn: true,
      })
      const proposed = Math.max(0, this.deps.store.list({ status: 'proposed' }).length - before)
      log.info('tasks', discoveryOutcome(proposed, result.turns, result.turnLimitReached))
    } catch (err) {
      log.warn('tasks', `Discovery failed: ${err}`)
    }
  }
}

export function createDiscovery(deps: DiscoveryDeps): Discovery {
  return new Discovery(deps)
}

/** How a pass ended, for the log: "Discovery complete" said nothing about whether it had. */
export function discoveryOutcome(
  proposed: number,
  turns: number | undefined,
  hitCap: boolean | undefined,
): string {
  const what = proposed > 0 ? `proposed ${proposed}` : 'nothing proposed'
  if (hitCap) return `Discovery hit its ${turns ?? DISCOVERY_MAX_TURNS}-turn cap: ${what}`
  return `Discovery finished${turns !== undefined ? ` in ${turns} turns` : ''}: ${what}`
}
