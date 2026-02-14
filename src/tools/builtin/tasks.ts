import type { Tool, ToolResult } from '../types'
import type { TaskStore } from '../../tasks/store'
import type { TaskRunner } from '../../tasks/runner'
import type { NewTask, TaskKind, TaskNotify, EventSourceType } from '../../tasks/types'
import { parseInterval, formatInterval } from '../../tasks/parse-interval'
import { log } from '../../util/logger'

interface TaskToolContext {
  channel: string
  channelTarget: string
}

export function createTaskTools(
  store: TaskStore,
  runner: TaskRunner,
  maxActiveTasks: number,
  getContext: () => TaskToolContext,
): {
  taskAddTool: Tool
  taskProposeTool: Tool
  taskListTool: Tool
  taskPauseTool: Tool
  taskResumeTool: Tool
  taskCancelTool: Tool
  taskRunNowTool: Tool
  taskHistoryTool: Tool
} {
  const taskAddTool: Tool = {
    definition: {
      name: 'task_add',
      description: 'Create a new background task. The task activates immediately. Use for scheduled checks, event watchers, or one-shot jobs.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short identifier for the task (e.g., "watch-ci-main")' },
          description: { type: 'string', description: 'What this task does' },
          prompt: { type: 'string', description: 'The agent prompt to execute each run' },
          kind: { type: 'string', description: 'Task type: scheduled, event, or oneshot' },
          interval: { type: 'string', description: 'Run interval: "30m", "2h", "1d" (scheduled only)' },
          event_source: { type: 'string', description: 'Event source: file, webhook, github, command (event only)' },
          event_config: { type: 'object', description: 'Source-specific config (event only)' },
          workflow: { type: 'object', description: 'Workflow definition for deterministic execution (optional)' },
          notify: { type: 'string', description: 'Notification mode: always, on_change, on_failure, never (default: on_change)' },
          max_runs: { type: 'number', description: 'Maximum number of runs (null = unlimited)' },
          memory_context: { type: 'array', description: 'Memory keys to pre-load before each run' },
          memory_category: { type: 'string', description: 'Category filter for proactive memory retrieval' },
        },
        required: ['name', 'description', 'prompt', 'kind'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const kind = params.kind as TaskKind
      if (!['scheduled', 'event', 'oneshot'].includes(kind)) {
        return { success: false, output: `Invalid kind: ${kind}. Must be scheduled, event, or oneshot.` }
      }

      // Check active task limit
      if (store.activeCount() >= maxActiveTasks) {
        return { success: false, output: `Cannot create task: active task limit reached (${maxActiveTasks}). Pause or cancel existing tasks first.` }
      }

      let intervalMs: number | undefined
      if (kind === 'scheduled') {
        const interval = params.interval as string | undefined
        if (!interval) {
          return { success: false, output: 'Scheduled tasks require an interval (e.g., "30m", "2h").' }
        }
        intervalMs = parseInterval(interval)
        if (!intervalMs) {
          return { success: false, output: `Could not parse interval: "${interval}". Try "30m", "2h", "1d".` }
        }
      }

      if (kind === 'event' && !params.event_source) {
        return { success: false, output: 'Event tasks require event_source (file, webhook, github, command).' }
      }

      const ctx = getContext()
      const input: NewTask = {
        name: params.name as string,
        description: params.description as string,
        prompt: params.prompt as string,
        kind,
        intervalMs,
        eventSource: params.event_source as EventSourceType | undefined,
        eventConfig: params.event_config,
        workflow: params.workflow,
        notify: (params.notify as TaskNotify) ?? 'on_change',
        maxRuns: params.max_runs as number | undefined,
        memoryContext: params.memory_context as string[] | undefined,
        memoryCategory: params.memory_category as string | undefined,
        channel: ctx.channel,
        channelTarget: ctx.channelTarget,
        createdBy: 'user',
      }

      try {
        const task = store.create(input)
        runner.activateTask(task.id)

        const parts = [`Created task **${task.name}** (${task.id})`]
        parts.push(`Kind: ${task.kind}`)
        if (intervalMs) parts.push(`Interval: ${formatInterval(intervalMs)}`)
        if (task.eventSource) parts.push(`Event source: ${task.eventSource}`)
        if (task.maxRuns) parts.push(`Max runs: ${task.maxRuns}`)
        parts.push(`Notify: ${task.notify}`)
        parts.push('Status: active')

        return { success: true, output: parts.join('\n') }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, output: `Failed to create task: ${msg}` }
      }
    },
  }

  const taskProposeTool: Tool = {
    definition: {
      name: 'task_propose',
      description: 'Propose a background task for user approval. The task stays inactive until approved. Use when you notice an opportunity for useful background work.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short identifier for the task' },
          description: { type: 'string', description: 'What this task does' },
          prompt: { type: 'string', description: 'The agent prompt to execute each run' },
          kind: { type: 'string', description: 'Task type: scheduled, event, or oneshot' },
          interval: { type: 'string', description: 'Run interval (scheduled only)' },
          event_source: { type: 'string', description: 'Event source type (event only)' },
          event_config: { type: 'object', description: 'Source-specific config (event only)' },
          notify: { type: 'string', description: 'Notification mode (default: on_change)' },
          max_runs: { type: 'number', description: 'Maximum number of runs' },
          reason: { type: 'string', description: 'Why you think this task would be useful' },
        },
        required: ['name', 'description', 'prompt', 'kind', 'reason'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const name = params.name as string

      // Check cooldown — don't re-propose recently rejected tasks
      if (store.wasRecentlyRejected(name, 24 * 60 * 60 * 1000)) {
        return { success: false, output: `Task "${name}" was rejected in the last 24h. Not re-proposing.` }
      }

      if (store.activeCount() >= maxActiveTasks) {
        return { success: false, output: `Cannot propose task: active task limit reached (${maxActiveTasks}).` }
      }

      let intervalMs: number | undefined
      if (params.interval) {
        intervalMs = parseInterval(params.interval as string)
      }

      const ctx = getContext()
      const input: NewTask = {
        name,
        description: params.description as string,
        prompt: params.prompt as string,
        kind: params.kind as TaskKind,
        intervalMs,
        eventSource: params.event_source as EventSourceType | undefined,
        eventConfig: params.event_config,
        notify: (params.notify as TaskNotify) ?? 'on_change',
        maxRuns: params.max_runs as number | undefined,
        channel: ctx.channel,
        channelTarget: ctx.channelTarget,
        createdBy: 'agent',
      }

      try {
        const task = store.create(input)
        // Create proposal record
        store.createProposal(task.id, ctx.channel, ctx.channelTarget)

        const reason = params.reason as string
        return {
          success: true,
          output: `Proposed task **${task.name}** (${task.id})\n${task.description}\nReason: ${reason}\n\nAwaiting user approval.`,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, output: `Failed to propose task: ${msg}` }
      }
    },
  }

  const taskListTool: Tool = {
    definition: {
      name: 'task_list',
      description: 'List background tasks. Optionally filter by status.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filter: active, paused, proposed, done, failed' },
        },
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const filter = params.status
        ? { status: params.status as 'active' | 'paused' | 'proposed' | 'done' | 'failed' }
        : undefined

      const tasks = store.list(filter)

      if (tasks.length === 0) {
        return { success: true, output: filter ? `No ${filter.status} tasks.` : 'No tasks.' }
      }

      const lines = tasks.map(t => {
        const parts = [`- **${t.name}** (${t.id}) [${t.status}] — ${t.description}`]
        if (t.kind === 'scheduled' && t.intervalMs) {
          parts.push(`  Schedule: every ${formatInterval(t.intervalMs)}`)
        }
        if (t.kind === 'event' && t.eventSource) {
          parts.push(`  Event: ${t.eventSource}`)
        }
        parts.push(`  Runs: ${t.runCount}${t.maxRuns ? `/${t.maxRuns}` : ''} | Notify: ${t.notify}`)
        if (t.lastRunAt) {
          const ago = Math.round((Date.now() - t.lastRunAt) / 1000)
          parts.push(`  Last run: ${ago}s ago`)
        }
        return parts.join('\n')
      })

      return { success: true, output: `${tasks.length} task(s):\n\n${lines.join('\n\n')}` }
    },
  }

  const taskPauseTool: Tool = {
    definition: {
      name: 'task_pause',
      description: 'Pause an active background task. It stops running but is not deleted.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task ID to pause' },
        },
        required: ['id'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const id = params.id as string
      const task = store.get(id)
      if (!task) return { success: false, output: `Task ${id} not found.` }
      if (task.status !== 'active') return { success: false, output: `Task ${id} is not active (status: ${task.status}).` }

      store.update(id, { status: 'paused' })
      runner.deactivateTask(id)
      return { success: true, output: `Paused task "${task.name}" (${id}).` }
    },
  }

  const taskResumeTool: Tool = {
    definition: {
      name: 'task_resume',
      description: 'Resume a paused background task.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task ID to resume' },
        },
        required: ['id'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const id = params.id as string
      const task = store.get(id)
      if (!task) return { success: false, output: `Task ${id} not found.` }
      if (task.status !== 'paused') return { success: false, output: `Task ${id} is not paused (status: ${task.status}).` }

      store.update(id, { status: 'active', consecutiveFailures: 0 })
      runner.activateTask(id)
      return { success: true, output: `Resumed task "${task.name}" (${id}).` }
    },
  }

  const taskCancelTool: Tool = {
    definition: {
      name: 'task_cancel',
      description: 'Delete a background task permanently.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task ID to cancel' },
        },
        required: ['id'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const id = params.id as string
      const task = store.get(id)
      if (!task) return { success: false, output: `Task ${id} not found.` }

      runner.deactivateTask(id)
      store.delete(id)
      return { success: true, output: `Cancelled task "${task.name}" (${id}).` }
    },
  }

  const taskRunNowTool: Tool = {
    definition: {
      name: 'task_run_now',
      description: 'Trigger a background task to run immediately, regardless of its schedule.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task ID to run' },
        },
        required: ['id'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const id = params.id as string
      const task = store.get(id)
      if (!task) return { success: false, output: `Task ${id} not found.` }

      try {
        const run = await runner.runNow(id)
        if (!run) return { success: false, output: `Failed to trigger task ${id}.` }

        return {
          success: run.status === 'success',
          output: run.status === 'success'
            ? `Task "${task.name}" completed:\n${run.result ?? '(no output)'}`
            : `Task "${task.name}" failed: ${run.error ?? 'unknown error'}`,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, output: `Error running task: ${msg}` }
      }
    },
  }

  const taskHistoryTool: Tool = {
    definition: {
      name: 'task_history',
      description: 'Show recent run history for a background task.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task ID' },
          limit: { type: 'number', description: 'Number of runs to show (default: 5)' },
        },
        required: ['id'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const id = params.id as string
      const limit = (params.limit as number) ?? 5
      const task = store.get(id)
      if (!task) return { success: false, output: `Task ${id} not found.` }

      const runs = store.getRecentRuns(id, limit)
      if (runs.length === 0) {
        return { success: true, output: `No runs yet for task "${task.name}".` }
      }

      const lines = runs.map(r => {
        const duration = r.completedAt ? `${Math.round((r.completedAt - r.startedAt) / 1000)}s` : 'running'
        const time = new Date(r.startedAt).toISOString()
        let line = `- [${r.status}] ${time} (${duration})`
        if (r.tokensUsed) line += ` ${r.tokensUsed} tokens`
        if (r.error) line += `\n  Error: ${r.error.slice(0, 200)}`
        if (r.result) line += `\n  Result: ${r.result.slice(0, 200)}`
        return line
      })

      return {
        success: true,
        output: `Recent runs for "${task.name}" (${task.runCount} total):\n\n${lines.join('\n\n')}`,
      }
    },
  }

  return {
    taskAddTool,
    taskProposeTool,
    taskListTool,
    taskPauseTool,
    taskResumeTool,
    taskCancelTool,
    taskRunNowTool,
    taskHistoryTool,
  }
}
