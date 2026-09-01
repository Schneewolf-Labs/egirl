import type { DelegationRegistry, DelegationSnapshot } from '../../delegation-registry'
import type { Tool, ToolResult } from '../../types'

/**
 * The operator's hands on a running delegation: watch it, correct it, end it.
 *
 * Three tools rather than one `code_agent_control(action, …)` — the enum-dispatch shape saves
 * schema tokens and spends them again on a small local model pairing the wrong arguments with
 * the action. The names deliberately echo `process_*`, which is the same handle-shaped idea the
 * model already knows how to use.
 */

function summarize(d: DelegationSnapshot): string {
  const seconds = (((d.finishedAt ?? Date.now()) - d.startedAt) / 1000).toFixed(0)
  const task = d.task.length > 80 ? `${d.task.slice(0, 77)}...` : d.task
  const cost = d.costUsd !== undefined ? ` $${d.costUsd.toFixed(4)}` : ''
  const turns = d.turns !== undefined ? ` turns=${d.turns}` : ''
  const steers = d.steerCount > 0 ? ` steers=${d.steerCount}` : ''
  const steerable = d.status === 'running' && !d.steerable ? ' (not steerable)' : ''
  return `${d.id} [${d.status}${steerable}] ${d.provider} age=${seconds}s${turns}${cost}${steers}\n  task: ${task}\n  cwd: ${d.workingDir}`
}

export function createDelegationControlTools(registry: DelegationRegistry): {
  statusTool: Tool
  steerTool: Tool
  stopTool: Tool
} {
  const statusTool: Tool = {
    definition: {
      name: 'code_agent_status',
      description: [
        'Check on background code-agent delegations started with code_agent(background: true).',
        "With no id, lists them all. With an id, shows that delegation's progress so far and,",
        'once it has finished, its full result. Pass since_line (from a previous next_line) to',
        'see only what is new.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Delegation id from code_agent (omit to list all)' },
          since_line: {
            type: 'number',
            description:
              'Only return progress after this index (use next_line from a previous call)',
          },
          tail_lines: { type: 'number', description: 'Cap returned progress to the last N lines' },
        },
      },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const id = params.id as string | undefined
      if (!id) {
        const all = registry.list()
        if (all.length === 0) {
          return { success: true, output: 'No background delegations.' }
        }
        return { success: true, output: all.map(summarize).join('\n\n') }
      }

      const out = registry.output(id, {
        sinceLine: typeof params.since_line === 'number' ? params.since_line : undefined,
        tailLines: typeof params.tail_lines === 'number' ? params.tail_lines : undefined,
      })
      if (!out) return { success: false, output: `No delegation with id ${id}` }

      const sections = [summarize(out)]
      sections.push(
        `progress (next_line=${out.nextLine}):\n${out.lines.join('\n') || '(none yet)'}`,
      )
      if (out.result !== undefined) sections.push(`result:\n${out.result}`)
      return { success: true, output: sections.join('\n\n') }
    },
  }

  const steerTool: Tool = {
    definition: {
      name: 'code_agent_steer',
      description: [
        'Send a correction or extra instruction to a running background delegation.',
        "It arrives as the next message in that delegation's session, so it keeps everything",
        'the code agent has already worked out — use this instead of stopping and re-delegating',
        'when the work is going the wrong way or you have learned something it needs to know.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Delegation id from code_agent' },
          message: { type: 'string', description: 'What to tell the running code agent' },
        },
        required: ['id', 'message'],
      },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const id = params.id as string | undefined
      const message = params.message as string | undefined
      if (!id || !message) return { success: false, output: 'id and message are required' }

      switch (registry.steer(id, message)) {
        case 'sent':
          return { success: true, output: `Steered ${id}. It lands on the delegate's next turn.` }
        case 'unknown':
          return { success: false, output: `No delegation with id ${id}` }
        case 'not_running':
          return { success: false, output: `Delegation ${id} is no longer running.` }
        case 'not_steerable':
          return {
            success: false,
            output:
              `Delegation ${id} runs on a backend that cannot take input mid-run. ` +
              'Stop it with code_agent_stop and delegate again with the corrected task.',
          }
      }
    },
  }

  const stopTool: Tool = {
    definition: {
      name: 'code_agent_stop',
      description: [
        'Stop a running background delegation. Work already done on disk is kept, and whatever',
        'the code agent reported before the stop stays readable with code_agent_status.',
        'Prefer code_agent_steer when the run is worth correcting rather than ending.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Delegation id from code_agent' } },
        required: ['id'],
      },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const id = params.id as string | undefined
      if (!id) return { success: false, output: 'id is required' }
      if (!registry.get(id)) return { success: false, output: `No delegation with id ${id}` }
      return registry.stop(id)
        ? { success: true, output: `Stopping ${id}. Read what it managed with code_agent_status.` }
        : { success: false, output: `Delegation ${id} is not running.` }
    },
  }

  return { statusTool, steerTool, stopTool }
}
