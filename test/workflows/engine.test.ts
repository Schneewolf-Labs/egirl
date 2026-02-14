import { describe, expect, test } from 'bun:test'
import type { ToolCall } from '../../src/providers/types'
import type { ToolExecutor } from '../../src/tools/executor'
import type { ToolResult } from '../../src/tools/types'
import { executeWorkflow, interpolate } from '../../src/workflows/engine'
import type { WorkflowDefinition } from '../../src/workflows/types'

/** Create a mock ToolExecutor that returns predefined results per tool name */
function _mockExecutor(results: Record<string, ToolResult>): ToolExecutor {
  return {
    execute(call: ToolCall, _cwd: string): Promise<ToolResult> {
      const result = results[call.name]
      if (!result) {
        return Promise.resolve({ success: false, output: `Unknown tool: ${call.name}` })
      }
      return Promise.resolve(result)
    },
  } as unknown as ToolExecutor
}

/** Mock executor that records calls and returns results in sequence */
function recordingExecutor(resultSequence: ToolResult[]): {
  executor: ToolExecutor
  calls: ToolCall[]
} {
  const calls: ToolCall[] = []
  let index = 0
  const executor = {
    execute(call: ToolCall, _cwd: string): Promise<ToolResult> {
      calls.push(call)
      const result = resultSequence[index] ?? { success: false, output: 'No more results' }
      index++
      return Promise.resolve(result)
    },
  } as unknown as ToolExecutor
  return { executor, calls }
}

describe('interpolate', () => {
  test('interpolates params', () => {
    const ctx = { params: { branch: 'main', count: 5 }, steps: {} }
    expect(interpolate('git pull origin {{params.branch}}', ctx)).toBe('git pull origin main')
  })

  test('interpolates step output', () => {
    const ctx = {
      params: {},
      steps: {
        test: {
          step: 'test',
          tool: 'exec',
          success: false,
          output: 'FAIL: 3 errors',
          skipped: false,
        },
      },
    }
    expect(interpolate('Fix these: {{steps.test.output}}', ctx)).toBe('Fix these: FAIL: 3 errors')
  })

  test('interpolates step success', () => {
    const ctx = {
      params: {},
      steps: {
        build: { step: 'build', tool: 'exec', success: true, output: 'ok', skipped: false },
      },
    }
    expect(interpolate('Build passed: {{steps.build.success}}', ctx)).toBe('Build passed: true')
  })

  test('returns empty string for missing references', () => {
    const ctx = { params: {}, steps: {} }
    expect(interpolate('{{params.missing}}', ctx)).toBe('')
    expect(interpolate('{{steps.missing.output}}', ctx)).toBe('')
  })

  test('interpolates inside objects and arrays', () => {
    const ctx = { params: { file: 'src/index.ts' }, steps: {} }
    const result = interpolate({ path: '{{params.file}}', items: ['{{params.file}}'] }, ctx)
    expect(result).toEqual({ path: 'src/index.ts', items: ['src/index.ts'] })
  })

  test('passes through non-string values unchanged', () => {
    const ctx = { params: {}, steps: {} }
    expect(interpolate(42, ctx)).toBe(42)
    expect(interpolate(true, ctx)).toBe(true)
    expect(interpolate(null, ctx)).toBe(null)
  })
})

describe('executeWorkflow', () => {
  test('runs all steps in order', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test-wf',
      description: 'test',
      steps: [
        { name: 'step1', tool: 'tool_a', params: {} },
        { name: 'step2', tool: 'tool_b', params: {} },
      ],
    }

    const { executor, calls } = recordingExecutor([
      { success: true, output: 'a done' },
      { success: true, output: 'b done' },
    ])

    const result = await executeWorkflow(workflow, {}, executor, '/tmp')

    expect(result.success).toBe(true)
    expect(result.steps).toHaveLength(2)
    expect(calls).toHaveLength(2)
    expect(calls[0].name).toBe('tool_a')
    expect(calls[1].name).toBe('tool_b')
  })

  test('aborts on failure by default', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test-wf',
      description: 'test',
      steps: [
        { name: 'step1', tool: 'tool_a', params: {} },
        { name: 'step2', tool: 'tool_b', params: {} },
        { name: 'step3', tool: 'tool_c', params: {} },
      ],
    }

    const { executor, calls } = recordingExecutor([
      { success: true, output: 'ok' },
      { success: false, output: 'failed' },
      { success: true, output: 'should not run' },
    ])

    const result = await executeWorkflow(workflow, {}, executor, '/tmp')

    expect(result.success).toBe(false)
    expect(calls).toHaveLength(2) // step3 never executed
    expect(result.steps[2].skipped).toBe(true)
  })

  test('continues on error when continue_on_error is set', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test-wf',
      description: 'test',
      steps: [
        { name: 'step1', tool: 'tool_a', params: {}, continue_on_error: true },
        { name: 'step2', tool: 'tool_b', params: {} },
      ],
    }

    const { executor, calls } = recordingExecutor([
      { success: false, output: 'failed but continuing' },
      { success: true, output: 'ran anyway' },
    ])

    const result = await executeWorkflow(workflow, {}, executor, '/tmp')

    expect(result.success).toBe(true)
    expect(calls).toHaveLength(2)
    expect(result.steps[0].success).toBe(false)
    expect(result.steps[1].success).toBe(true)
  })

  test('conditional step runs on failure', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test-fix',
      description: 'test',
      steps: [
        {
          name: 'test',
          tool: 'execute_command',
          params: { command: 'bun test' },
          continue_on_error: true,
        },
        { name: 'fix', tool: 'code_agent', params: { task: 'fix' }, if: 'test.failed' },
      ],
    }

    const { executor, calls } = recordingExecutor([
      { success: false, output: 'test failures' },
      { success: true, output: 'fixed' },
    ])

    const result = await executeWorkflow(workflow, {}, executor, '/tmp')

    expect(result.success).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[1].name).toBe('code_agent')
  })

  test('conditional step is skipped when condition not met', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test-fix',
      description: 'test',
      steps: [
        {
          name: 'test',
          tool: 'execute_command',
          params: { command: 'bun test' },
          continue_on_error: true,
        },
        { name: 'fix', tool: 'code_agent', params: { task: 'fix' }, if: 'test.failed' },
        { name: 'commit', tool: 'git_commit', params: { message: 'done' } },
      ],
    }

    const { executor, calls } = recordingExecutor([
      { success: true, output: 'all pass' },
      { success: true, output: 'committed' },
    ])

    const result = await executeWorkflow(workflow, {}, executor, '/tmp')

    expect(result.success).toBe(true)
    expect(calls).toHaveLength(2) // fix was skipped
    expect(calls[0].name).toBe('execute_command')
    expect(calls[1].name).toBe('git_commit')
    expect(result.steps[1].skipped).toBe(true) // fix step skipped
  })

  test('always condition runs regardless of workflow state', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test-wf',
      description: 'test',
      steps: [
        { name: 'step1', tool: 'tool_a', params: {} },
        { name: 'cleanup', tool: 'tool_b', params: {}, if: 'always' },
      ],
    }

    const { executor, calls } = recordingExecutor([
      { success: false, output: 'failed' },
      { success: true, output: 'cleaned up' },
    ])

    const result = await executeWorkflow(workflow, {}, executor, '/tmp')

    expect(result.success).toBe(false)
    expect(calls).toHaveLength(2) // cleanup ran despite failure
  })

  test('interpolates params and step outputs', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test-wf',
      description: 'test',
      steps: [
        { name: 'step1', tool: 'tool_a', params: { cmd: '{{params.branch}}' } },
        { name: 'step2', tool: 'tool_b', params: { input: '{{steps.step1.output}}' } },
      ],
    }

    const { executor, calls } = recordingExecutor([
      { success: true, output: 'step1 result' },
      { success: true, output: 'ok' },
    ])

    await executeWorkflow(workflow, { branch: 'dev' }, executor, '/tmp')

    expect(calls[0].arguments).toEqual({ cmd: 'dev' })
    expect(calls[1].arguments).toEqual({ input: 'step1 result' })
  })

  test('applies default params', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test-wf',
      description: 'test',
      params: {
        branch: { type: 'string', description: 'branch', default: 'main' },
      },
      steps: [{ name: 'step1', tool: 'tool_a', params: { cmd: 'git pull {{params.branch}}' } }],
    }

    const { executor, calls } = recordingExecutor([{ success: true, output: 'ok' }])

    await executeWorkflow(workflow, {}, executor, '/tmp')

    expect(calls[0].arguments).toEqual({ cmd: 'git pull main' })
  })

  test('retries on failure', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test-wf',
      description: 'test',
      steps: [{ name: 'flaky', tool: 'tool_a', params: {}, retry: 2 }],
    }

    const { executor, calls } = recordingExecutor([
      { success: false, output: 'fail 1' },
      { success: false, output: 'fail 2' },
      { success: true, output: 'finally worked' },
    ])

    const result = await executeWorkflow(workflow, {}, executor, '/tmp')

    expect(result.success).toBe(true)
    expect(calls).toHaveLength(3) // 1 initial + 2 retries
    expect(result.steps[0].output).toBe('finally worked')
  })

  test('succeeded condition works', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test-wf',
      description: 'test',
      steps: [
        { name: 'build', tool: 'tool_a', params: {}, continue_on_error: true },
        { name: 'deploy', tool: 'tool_b', params: {}, if: 'build.succeeded' },
        { name: 'notify_failure', tool: 'tool_c', params: {}, if: 'build.failed' },
      ],
    }

    // Build succeeds
    const { executor: ex1, calls: calls1 } = recordingExecutor([
      { success: true, output: 'built' },
      { success: true, output: 'deployed' },
    ])

    const r1 = await executeWorkflow(workflow, {}, ex1, '/tmp')
    expect(r1.success).toBe(true)
    expect(calls1).toHaveLength(2)
    expect(calls1[1].name).toBe('tool_b') // deploy ran
    expect(r1.steps[2].skipped).toBe(true) // notify_failure skipped

    // Build fails
    const { executor: ex2, calls: calls2 } = recordingExecutor([
      { success: false, output: 'build error' },
      { success: true, output: 'notified' },
    ])

    const r2 = await executeWorkflow(workflow, {}, ex2, '/tmp')
    expect(r2.success).toBe(true) // continue_on_error
    expect(calls2).toHaveLength(2)
    expect(calls2[1].name).toBe('tool_c') // notify_failure ran
    expect(r2.steps[1].skipped).toBe(true) // deploy skipped
  })

  test('full pull-test-fix scenario: tests pass', async () => {
    const workflow: WorkflowDefinition = {
      name: 'pull-test-fix',
      description: 'test scenario',
      steps: [
        { name: 'pull', tool: 'execute_command', params: { command: 'git pull' } },
        {
          name: 'test',
          tool: 'execute_command',
          params: { command: 'bun test' },
          continue_on_error: true,
        },
        {
          name: 'fix',
          tool: 'code_agent',
          params: { task: 'fix: {{steps.test.output}}' },
          if: 'test.failed',
        },
        {
          name: 'retest',
          tool: 'execute_command',
          params: { command: 'bun test' },
          if: 'test.failed',
        },
        { name: 'commit', tool: 'git_commit', params: { message: 'update' } },
        { name: 'push', tool: 'execute_command', params: { command: 'git push' } },
      ],
    }

    const { executor, calls } = recordingExecutor([
      { success: true, output: 'pulled' },
      { success: true, output: 'all tests pass' },
      // fix and retest skipped
      { success: true, output: 'committed' },
      { success: true, output: 'pushed' },
    ])

    const result = await executeWorkflow(workflow, {}, executor, '/tmp')

    expect(result.success).toBe(true)
    expect(calls).toHaveLength(4) // pull, test, commit, push (fix+retest skipped)
    expect(result.steps[2].skipped).toBe(true) // fix
    expect(result.steps[3].skipped).toBe(true) // retest
  })

  test('full pull-test-fix scenario: tests fail, fix works', async () => {
    const workflow: WorkflowDefinition = {
      name: 'pull-test-fix',
      description: 'test scenario',
      steps: [
        { name: 'pull', tool: 'execute_command', params: { command: 'git pull' } },
        {
          name: 'test',
          tool: 'execute_command',
          params: { command: 'bun test' },
          continue_on_error: true,
        },
        {
          name: 'fix',
          tool: 'code_agent',
          params: { task: 'fix: {{steps.test.output}}' },
          if: 'test.failed',
        },
        {
          name: 'retest',
          tool: 'execute_command',
          params: { command: 'bun test' },
          if: 'test.failed',
        },
        { name: 'commit', tool: 'git_commit', params: { message: 'update' } },
        { name: 'push', tool: 'execute_command', params: { command: 'git push' } },
      ],
    }

    const { executor, calls } = recordingExecutor([
      { success: true, output: 'pulled' },
      { success: false, output: 'FAIL: test_foo' },
      { success: true, output: 'fixed test_foo' },
      { success: true, output: 'all tests pass' },
      { success: true, output: 'committed' },
      { success: true, output: 'pushed' },
    ])

    const result = await executeWorkflow(workflow, {}, executor, '/tmp')

    expect(result.success).toBe(true)
    expect(calls).toHaveLength(6) // all steps ran
    expect(calls[2].arguments.task).toContain('FAIL: test_foo') // interpolated test output
  })

  test('output format is readable', async () => {
    const workflow: WorkflowDefinition = {
      name: 'my-workflow',
      description: 'test',
      steps: [
        { name: 'pass', tool: 'tool_a', params: {} },
        { name: 'fail', tool: 'tool_b', params: {} },
      ],
    }

    const { executor } = recordingExecutor([
      { success: true, output: 'ok' },
      { success: false, output: 'error line 1\nerror line 2' },
    ])

    const result = await executeWorkflow(workflow, {}, executor, '/tmp')

    expect(result.output).toContain('Workflow: my-workflow')
    expect(result.output).toContain('FAILED')
    expect(result.output).toContain('● pass')
    expect(result.output).toContain('✗ fail')
  })
})
