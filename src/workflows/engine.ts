import type { ToolExecutor } from '../tools/executor'
import type { WorkflowDefinition, WorkflowStep, StepResult, WorkflowResult } from './types'
import { log } from '../util/logger'

interface StepContext {
  params: Record<string, unknown>
  steps: Record<string, StepResult>
}

/**
 * Interpolate {{params.x}} and {{steps.x.output}} / {{steps.x.success}} in a value.
 * Walks strings recursively through objects and arrays.
 */
export function interpolate(value: unknown, ctx: StepContext): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{(.+?)\}\}/g, (_match, expr: string) => {
      const trimmed = expr.trim()
      const parts = trimmed.split('.')

      if (parts[0] === 'params' && parts.length === 2) {
        const val = ctx.params[parts[1]]
        return val !== undefined ? String(val) : ''
      }

      if (parts[0] === 'steps' && parts.length === 3) {
        const stepResult = ctx.steps[parts[1]]
        if (!stepResult) return ''
        if (parts[2] === 'output') return stepResult.output
        if (parts[2] === 'success') return String(stepResult.success)
        return ''
      }

      return ''
    })
  }

  if (Array.isArray(value)) {
    return value.map(item => interpolate(item, ctx))
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolate(v, ctx)
    }
    return result
  }

  return value
}

/**
 * Evaluate a step's `if` condition against completed step results.
 *
 * Supported conditions:
 *   - undefined / not set: run if workflow is not in failed state
 *   - 'always': always run
 *   - 'step_name.failed': run only if the named step failed
 *   - 'step_name.succeeded': run only if the named step succeeded
 */
function shouldRunStep(
  step: WorkflowStep,
  stepResults: Record<string, StepResult>,
  isWorkflowFailed: boolean
): boolean {
  const condition = step.if

  if (!condition) {
    return !isWorkflowFailed
  }

  if (condition === 'always') {
    return true
  }

  const dotIndex = condition.lastIndexOf('.')
  if (dotIndex === -1) return !isWorkflowFailed

  const stepName = condition.slice(0, dotIndex)
  const check = condition.slice(dotIndex + 1)
  const result = stepResults[stepName]

  if (!result) return false

  if (check === 'failed') return !result.success && !result.skipped
  if (check === 'succeeded') return result.success

  return !isWorkflowFailed
}

/**
 * Execute a workflow definition step-by-step using the provided ToolExecutor.
 */
export async function executeWorkflow(
  definition: WorkflowDefinition,
  params: Record<string, unknown>,
  toolExecutor: ToolExecutor,
  cwd: string
): Promise<WorkflowResult> {
  const resolvedParams = resolveParams(definition, params)
  const ctx: StepContext = { params: resolvedParams, steps: {} }
  const stepResults: StepResult[] = []
  let isWorkflowFailed = false

  log.info('workflow', `Starting workflow: ${definition.name}`)

  for (const step of definition.steps) {
    // Check if step should run
    if (!shouldRunStep(step, ctx.steps, isWorkflowFailed)) {
      const skipped: StepResult = {
        step: step.name,
        tool: step.tool,
        success: false,
        output: 'Skipped',
        skipped: true,
      }
      ctx.steps[step.name] = skipped
      stepResults.push(skipped)
      log.debug('workflow', `Skipping step: ${step.name}`)
      continue
    }

    log.info('workflow', `Running step: ${step.name} (${step.tool})`)

    const interpolatedParams = interpolate(step.params, ctx) as Record<string, unknown>
    const maxAttempts = (step.retry ?? 0) + 1
    let result: StepResult | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const toolResult = await toolExecutor.execute(
        { id: `wf_${step.name}_${attempt}`, name: step.tool, arguments: interpolatedParams },
        cwd
      )

      result = {
        step: step.name,
        tool: step.tool,
        success: toolResult.success,
        output: toolResult.output,
        skipped: false,
      }

      if (toolResult.success) break

      if (attempt < maxAttempts) {
        log.info('workflow', `Step ${step.name} failed (attempt ${attempt}/${maxAttempts}), retrying`)
      }
    }

    // result is always set because maxAttempts >= 1
    ctx.steps[step.name] = result!
    stepResults.push(result!)

    if (!result!.success) {
      log.info('workflow', `Step ${step.name} failed: ${result!.output.slice(0, 200)}`)
      if (!step.continue_on_error) {
        isWorkflowFailed = true
      }
    } else {
      log.info('workflow', `Step ${step.name} succeeded`)
    }
  }

  const success = !isWorkflowFailed
  const output = formatWorkflowOutput(definition.name, stepResults, success)

  log.info('workflow', `Workflow ${definition.name} ${success ? 'succeeded' : 'failed'}`)

  return {
    workflow: definition.name,
    success,
    steps: stepResults,
    output,
  }
}

function resolveParams(
  definition: WorkflowDefinition,
  provided: Record<string, unknown>
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...provided }

  if (definition.params) {
    for (const [key, spec] of Object.entries(definition.params)) {
      if (resolved[key] === undefined && spec.default !== undefined) {
        resolved[key] = spec.default
      }
    }
  }

  return resolved
}

function formatWorkflowOutput(name: string, steps: StepResult[], success: boolean): string {
  const lines: string[] = [`Workflow: ${name}`, `Result: ${success ? 'SUCCESS' : 'FAILED'}`, '']

  for (const step of steps) {
    const icon = step.skipped ? '○' : step.success ? '●' : '✗'
    const status = step.skipped ? 'skipped' : step.success ? 'ok' : 'FAILED'
    lines.push(`${icon} ${step.step} (${step.tool}) — ${status}`)

    if (!step.skipped && !step.success) {
      // Show first few lines of failure output
      const preview = step.output.split('\n').slice(0, 5).join('\n')
      lines.push(`  ${preview}`)
    }
  }

  return lines.join('\n')
}
