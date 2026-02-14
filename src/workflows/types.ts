export interface WorkflowStep {
  /** Unique name for this step (used in conditions and interpolation) */
  name: string
  /** Tool to execute */
  tool: string
  /** Parameters to pass to the tool. Supports {{params.x}} and {{steps.x.output}} interpolation. */
  params: Record<string, unknown>
  /** If true, workflow continues even if this step fails */
  continue_on_error?: boolean
  /** Condition for running this step: 'always', 'step_name.failed', 'step_name.succeeded' */
  if?: string
  /** Number of times to retry on failure before giving up */
  retry?: number
}

export interface WorkflowParam {
  type: 'string' | 'number' | 'boolean'
  description: string
  default?: unknown
  required?: boolean
}

export interface WorkflowDefinition {
  name: string
  description: string
  steps: WorkflowStep[]
  params?: Record<string, WorkflowParam>
}

export interface StepResult {
  step: string
  tool: string
  success: boolean
  output: string
  skipped: boolean
}

export interface WorkflowResult {
  workflow: string
  success: boolean
  steps: StepResult[]
  output: string
}
