import { log } from '../util/logger'
import { gatherStandup } from '../standup'
import { retrieveForContext } from '../memory/retrieval'
import { AgentLoop } from '../agent/loop'
import type { AgentLoopDeps } from '../agent/loop'
import type { RuntimeConfig } from '../config'
import type { Router } from '../routing'
import type { ToolExecutor } from '../tools'
import type { LLMProvider } from '../providers/types'
import type { MemoryManager } from '../memory'
import type { TaskStore } from './store'
import type { TaskRunner } from './runner'
import type { TasksConfig } from './types'
import { formatInterval } from './parse-interval'

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

const MAX_PROPOSALS_PER_RUN = 3

export interface DiscoveryDeps {
  config: RuntimeConfig
  tasksConfig: TasksConfig
  store: TaskStore
  runner: TaskRunner
  toolExecutor: ToolExecutor
  router: Router
  localProvider: LLMProvider
  memory: MemoryManager | undefined
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
    log.info('tasks', `Discovery started (interval=${formatInterval(interval)})`)
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
    log.info('tasks', 'Running discovery')

    try {
      const cwd = this.deps.config.workspace.path

      // Gather workspace context
      const standup = await gatherStandup(cwd)

      // Get active tasks for context
      const activeTasks = this.deps.store.list({ status: 'active' })
      const tasksSummary = activeTasks.length > 0
        ? `Active tasks:\n${activeTasks.map(t => `- ${t.name}: ${t.description}`).join('\n')}`
        : 'No active background tasks.'

      // Proactive memory retrieval
      const contextParts: string[] = []
      if (standup.context) contextParts.push(standup.context)
      contextParts.push(tasksSummary)

      if (this.deps.memory) {
        const recalled = await retrieveForContext(
          'recent project context, pending work, open items',
          this.deps.memory,
          { scoreThreshold: 0.3, maxResults: 5, maxTokensBudget: 1500 },
        )
        if (recalled) contextParts.push(recalled)
      }

      // Create a scoped agent loop — always local
      const agentDeps: AgentLoopDeps = {
        config: this.deps.config,
        router: this.deps.router,
        toolExecutor: this.deps.toolExecutor,
        localProvider: this.deps.localProvider,
        remoteProvider: null, // Force local only
        sessionId: 'discovery',
        memory: this.deps.memory,
        additionalContext: contextParts.join('\n\n'),
      }

      const agent = new AgentLoop(agentDeps)
      await agent.run(DISCOVERY_PROMPT, { maxTurns: 5 })

      log.info('tasks', 'Discovery complete')
    } catch (err) {
      log.warn('tasks', `Discovery failed: ${err}`)
    }
  }
}

export function createDiscovery(deps: DiscoveryDeps): Discovery {
  return new Discovery(deps)
}
