import type { WorkflowDefinition } from './types'

export const pullTestFixWorkflow: WorkflowDefinition = {
  name: 'pull-test-fix',
  description: 'Pull latest changes, run tests, and if they fail delegate to code_agent for analysis and fixing. Re-runs tests after fix.',
  params: {
    branch: { type: 'string', description: 'Branch to pull from', default: 'main' },
    test_command: { type: 'string', description: 'Command to run tests', default: 'bun test' },
    remote: { type: 'string', description: 'Git remote name', default: 'origin' },
  },
  steps: [
    {
      name: 'pull',
      tool: 'execute_command',
      params: { command: 'git pull {{params.remote}} {{params.branch}}' },
    },
    {
      name: 'test',
      tool: 'execute_command',
      params: { command: '{{params.test_command}}' },
      continue_on_error: true,
    },
    {
      name: 'fix',
      tool: 'code_agent',
      params: {
        task: 'Tests failed. Here is the test output:\n\n{{steps.test.output}}\n\nAnalyze the failures and fix the code so tests pass.',
      },
      if: 'test.failed',
    },
    {
      name: 'retest',
      tool: 'execute_command',
      params: { command: '{{params.test_command}}' },
      if: 'test.failed',
    },
  ],
}

export const commitPushWorkflow: WorkflowDefinition = {
  name: 'commit-push',
  description: 'Stage all changes, commit with a message, and push to remote.',
  params: {
    message: { type: 'string', description: 'Commit message', required: true },
    branch: { type: 'string', description: 'Branch to push to', default: 'main' },
    remote: { type: 'string', description: 'Git remote name', default: 'origin' },
    files: { type: 'string', description: 'Files to stage (default: all)', default: '.' },
  },
  steps: [
    {
      name: 'commit',
      tool: 'git_commit',
      params: { message: '{{params.message}}', files: ['{{params.files}}'] },
    },
    {
      name: 'push',
      tool: 'execute_command',
      params: { command: 'git push {{params.remote}} {{params.branch}}' },
    },
  ],
}

export const pullTestCommitPushWorkflow: WorkflowDefinition = {
  name: 'pull-test-commit-push',
  description: 'Full pipeline: pull latest, run tests, fix failures if any, commit changes, and push.',
  params: {
    branch: { type: 'string', description: 'Branch name', default: 'main' },
    test_command: { type: 'string', description: 'Command to run tests', default: 'bun test' },
    message: { type: 'string', description: 'Commit message', required: true },
    remote: { type: 'string', description: 'Git remote name', default: 'origin' },
  },
  steps: [
    {
      name: 'pull',
      tool: 'execute_command',
      params: { command: 'git pull {{params.remote}} {{params.branch}}' },
    },
    {
      name: 'test',
      tool: 'execute_command',
      params: { command: '{{params.test_command}}' },
      continue_on_error: true,
    },
    {
      name: 'fix',
      tool: 'code_agent',
      params: {
        task: 'Tests failed. Here is the test output:\n\n{{steps.test.output}}\n\nAnalyze the failures and fix the code so tests pass.',
      },
      if: 'test.failed',
    },
    {
      name: 'retest',
      tool: 'execute_command',
      params: { command: '{{params.test_command}}' },
      if: 'test.failed',
    },
    {
      name: 'commit',
      tool: 'git_commit',
      params: { message: '{{params.message}}', files: ['.'] },
    },
    {
      name: 'push',
      tool: 'execute_command',
      params: { command: 'git push {{params.remote}} {{params.branch}}' },
    },
  ],
}

export const testFixWorkflow: WorkflowDefinition = {
  name: 'test-fix',
  description: 'Run tests, and if they fail delegate to code_agent to analyze and fix. Re-runs tests to verify.',
  params: {
    test_command: { type: 'string', description: 'Command to run tests', default: 'bun test' },
  },
  steps: [
    {
      name: 'test',
      tool: 'execute_command',
      params: { command: '{{params.test_command}}' },
      continue_on_error: true,
    },
    {
      name: 'fix',
      tool: 'code_agent',
      params: {
        task: 'Tests failed. Here is the test output:\n\n{{steps.test.output}}\n\nAnalyze the failures and fix the code so tests pass.',
      },
      if: 'test.failed',
    },
    {
      name: 'retest',
      tool: 'execute_command',
      params: { command: '{{params.test_command}}' },
      if: 'test.failed',
    },
  ],
}

export const builtinWorkflows: WorkflowDefinition[] = [
  pullTestFixWorkflow,
  commitPushWorkflow,
  pullTestCommitPushWorkflow,
  testFixWorkflow,
]
