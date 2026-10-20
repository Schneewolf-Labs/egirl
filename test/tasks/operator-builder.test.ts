/**
 * A task run drives the instance's own operator. The runner builds it through the builder it is
 * handed, and says whether the run continues the task's conversation or starts a new one, by the
 * same rule it applies to the stored transcript.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Operator, OperatorDeps } from '../../src/operator'
import { createTaskRunner } from '../../src/tasks/runner'
import { createTaskStore } from '../../src/tasks/store'
import { createToolExecutor } from '../../src/tools/executor'
import { makeConfig } from '../agent/helpers'

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), 'egirl-operator-builder-'))
  const config = makeConfig(workspace)
  const store = createTaskStore(join(workspace, 'tasks.db'))
  const built: OperatorDeps[] = []
  const runs: string[] = []
  const buildOperator = (deps: OperatorDeps): Operator => {
    built.push(deps)
    return {
      async run(message: string) {
        runs.push(message)
        return {
          content: 'did it',
          provider: 'claude',
          usage: { input_tokens: 1, output_tokens: 1 },
          turns: 1,
        }
      },
      getContext: () => ({
        systemPrompt: '',
        stablePromptPrefix: '',
        volatilePromptSuffix: '',
        messages: [],
        workspaceDir: workspace,
        sessionId: deps.sessionId,
      }),
    } as unknown as Operator
  }
  const runner = createTaskRunner({
    config,
    tasksConfig: config.tasks,
    store,
    toolExecutor: createToolExecutor(),
    localProvider: {
      name: 'unused',
      chat: async () => {
        throw new Error('a task on a hosted operator must not run on the local model')
      },
    },
    memory: undefined,
    outbound: new Map(),
    buildOperator,
  })
  const create = (overrides: { unbounded?: boolean; persistConversation?: boolean } = {}) =>
    store.create({
      name: `t${built.length}-${Math.random()}`,
      description: 'a task',
      kind: 'oneshot',
      prompt: 'go',
      channel: 'api',
      channelTarget: 'api:default',
      createdBy: 'user',
      ...overrides,
    })
  return { runner, store, built, runs, create }
}

describe('task runs build the instance operator', () => {
  test('a run goes through the builder with the task session and context, and starts fresh', async () => {
    const { runner, built, runs, create } = setup()
    const task = create()
    const run = await runner.runNow(task.id)
    expect(run?.status).toBe('success')
    expect(runs).toEqual(['go'])
    expect(built).toHaveLength(1)
    expect(built[0]?.sessionId).toBe(`task:${task.id}`)
    expect(built[0]?.additionalContext).toContain('Task: a task')
    expect(built[0]?.isFresh).toBe(true)
  })

  test('persist_conversation continues the task conversation', async () => {
    const { runner, built, create } = setup()
    const task = create({ persistConversation: true })
    await runner.runNow(task.id)
    expect(built[0]?.isFresh).toBe(false)
  })

  test('an unbounded run starts fresh: its state lives in its notes', async () => {
    const { runner, built, create } = setup()
    const task = create({ unbounded: true })
    await runner.runNow(task.id)
    expect(built[0]?.isFresh).toBe(true)
  })
})
