import type { ToolExecutor } from '../tools/executor'
import type { Tool, ToolResult } from '../tools/types'
import { executeWorkflow } from './engine'
import type { WorkflowDefinition, WorkflowStep } from './types'

/**
 * Create the run_workflow tool.
 * Accepts either a named built-in workflow or inline step definitions.
 */
export function createWorkflowTool(
  toolExecutor: ToolExecutor,
  workflows: WorkflowDefinition[],
): Tool {
  const workflowMap = new Map(workflows.map((w) => [w.name, w]))

  return {
    definition: {
      name: 'run_workflow',
      description: buildDescription(workflows),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'run'],
            description: 'Action: "list" to show available workflows, "run" to execute one',
          },
          workflow: {
            type: 'string',
            description: 'Name of a built-in workflow to run',
          },
          steps: {
            type: 'array',
            description: 'Ad-hoc workflow steps (alternative to named workflow)',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Step name' },
                tool: { type: 'string', description: 'Tool to execute' },
                params: {
                  type: 'object',
                  description:
                    'Tool parameters (supports {{params.x}} and {{steps.x.output}} interpolation)',
                },
                continue_on_error: {
                  type: 'boolean',
                  description: 'Continue workflow on failure (default: false)',
                },
                if: {
                  type: 'string',
                  description: 'Condition: "always", "step_name.failed", "step_name.succeeded"',
                },
                retry: { type: 'number', description: 'Retry count on failure' },
              },
              required: ['name', 'tool', 'params'],
            },
          },
          params: {
            type: 'object',
            description: 'Parameters to pass to the workflow',
          },
        },
        required: ['action'],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const action = params.action as string

      if (action === 'list') {
        return listWorkflows(workflows)
      }

      if (action === 'run') {
        return runWorkflow(params, workflowMap, toolExecutor, cwd)
      }

      return { success: false, output: `Unknown action: ${action}. Use "list" or "run".` }
    },
  }
}

function listWorkflows(workflows: WorkflowDefinition[]): ToolResult {
  if (workflows.length === 0) {
    return { success: true, output: 'No workflows available.' }
  }

  const lines: string[] = ['Available workflows:', '']

  for (const wf of workflows) {
    lines.push(`**${wf.name}** — ${wf.description}`)

    if (wf.params) {
      const paramDescs = Object.entries(wf.params).map(([key, spec]) => {
        const req = spec.required ? ' (required)' : ''
        const def = spec.default !== undefined ? ` [default: ${spec.default}]` : ''
        return `  - ${key}: ${spec.description}${req}${def}`
      })
      lines.push(...paramDescs)
    }

    const stepNames = wf.steps.map((s) => s.name).join(' → ')
    lines.push(`  Steps: ${stepNames}`)
    lines.push('')
  }

  return { success: true, output: lines.join('\n') }
}

async function runWorkflow(
  params: Record<string, unknown>,
  workflowMap: Map<string, WorkflowDefinition>,
  toolExecutor: ToolExecutor,
  cwd: string,
): Promise<ToolResult> {
  const workflowName = params.workflow as string | undefined
  const inlineSteps = params.steps as WorkflowStep[] | undefined
  const workflowParams = (params.params as Record<string, unknown>) ?? {}

  let definition: WorkflowDefinition

  if (workflowName) {
    const found = workflowMap.get(workflowName)
    if (!found) {
      const available = Array.from(workflowMap.keys()).join(', ')
      return {
        success: false,
        output: `Unknown workflow: "${workflowName}". Available: ${available}`,
      }
    }

    // Validate required params
    if (found.params) {
      const missing = Object.entries(found.params)
        .filter(([key, spec]) => spec.required && workflowParams[key] === undefined)
        .map(([key]) => key)

      if (missing.length > 0) {
        return {
          success: false,
          output: `Missing required params for workflow "${workflowName}": ${missing.join(', ')}`,
        }
      }
    }

    definition = found
  } else if (inlineSteps && inlineSteps.length > 0) {
    definition = {
      name: 'ad-hoc',
      description: 'Ad-hoc workflow',
      steps: inlineSteps,
    }
  } else {
    return {
      success: false,
      output: 'Provide either "workflow" (named workflow) or "steps" (inline steps) to run.',
    }
  }

  const result = await executeWorkflow(definition, workflowParams, toolExecutor, cwd)
  return {
    success: result.success,
    output: result.output,
  }
}

function buildDescription(workflows: WorkflowDefinition[]): string {
  const names = workflows.map((w) => w.name).join(', ')
  return (
    `Run a multi-step workflow that chains tool calls sequentially. ` +
    `Use action "list" to see available workflows, or "run" with a workflow name or inline steps. ` +
    `Built-in workflows: ${names}. ` +
    `Steps can reference previous results via {{steps.step_name.output}} and params via {{params.x}}.`
  )
}
