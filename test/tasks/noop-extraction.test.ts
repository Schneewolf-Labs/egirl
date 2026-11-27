/**
 * A no-op background run (a heartbeat with HEAD unchanged) wrote 1-3 near-duplicate memories
 * and lessons every time, depending on the extractor model. A run that succeeded, called only
 * read-only tools and hit no tool errors now skips both extractions; anything else gets both.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentLoopOptions } from '../../src/agent/types'
import type { MemoryManager } from '../../src/memory'
import type { Operator, OperatorDeps } from '../../src/operator'
import type { ChatRequest } from '../../src/providers/types'
import { createTaskRunner } from '../../src/tasks/runner'
import { createTaskStore } from '../../src/tasks/store'
import { createToolExecutor } from '../../src/tools/executor'
import { makeConfig } from '../agent/helpers'

interface FakeCall {
  name: string
  success: boolean
}

const REPLY =
  'Checked HEARTBEAT.md and the repo: HEAD is unchanged since the last run. The item stays unchecked because it recurs.'

function setup(calls: FakeCall[], skipNoopExtraction = true) {
  const workspace = mkdtempSync(join(tmpdir(), 'egirl-noop-extraction-'))
  const config = makeConfig(workspace)
  const store = createTaskStore(join(workspace, 'tasks.db'))
  const counts = { memory: 0, lesson: 0 }
  const buildOperator = (deps: OperatorDeps): Operator =>
    ({
      async run(_message: string, options?: AgentLoopOptions) {
        calls.forEach((call, i) => {
          options?.events?.onToolCallComplete?.(`c${i}`, call.name, {
            success: call.success,
            output: call.success ? 'ok' : 'error: failed',
          })
        })
        return {
          content: REPLY,
          provider: 'stub',
          usage: { input_tokens: 1, output_tokens: 1 },
          turns: 2,
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
    }) as unknown as Operator
  const memory = {
    get: () => undefined,
    searchHybrid: async () => [],
    set: async () => {},
  } as unknown as MemoryManager
  const runner = createTaskRunner({
    config,
    tasksConfig: { ...config.tasks, skipNoopExtraction },
    store,
    toolExecutor: createToolExecutor(),
    localProvider: {
      name: 'stub',
      async chat(req: ChatRequest) {
        const prompt = String(req.messages[0]?.content ?? '')
        if (prompt.startsWith('You are a memory extraction')) counts.memory++
        if (prompt.startsWith('You are a lesson extraction')) counts.lesson++
        return { content: '[]', usage: { input_tokens: 0, output_tokens: 0 } }
      },
    },
    memory,
    outbound: new Map(),
    buildOperator,
  })
  const run = async (): Promise<typeof counts> => {
    const task = store.create({
      name: 'heartbeat-like',
      description: 'a check-in',
      kind: 'oneshot',
      prompt: 'Check HEARTBEAT.md and the repo; report only if something changed.',
      channel: 'api',
      channelTarget: 'api:default',
      createdBy: 'user',
    })
    const result = await runner.runNow(task.id)
    expect(result?.status).toBe('success')
    await new Promise((resolve) => setTimeout(resolve, 10))
    return counts
  }
  return { run }
}

const READS: FakeCall[] = [
  { name: 'read_file', success: true },
  { name: 'git_status', success: true },
  { name: 'git_log', success: true },
]

describe('task runs that changed nothing skip extraction', () => {
  test('a clean run with only read-only tool calls calls neither extractor', async () => {
    expect(await setup(READS).run()).toEqual({ memory: 0, lesson: 0 })
  })

  test('a clean run with no tool calls at all calls neither extractor', async () => {
    expect(await setup([]).run()).toEqual({ memory: 0, lesson: 0 })
  })

  for (const name of ['write_file', 'edit_file', 'git_commit', 'execute_command']) {
    test(`a run with a ${name} call gets both extractions`, async () => {
      const calls = [...READS, { name, success: true }]
      expect(await setup(calls).run()).toEqual({ memory: 1, lesson: 1 })
    })
  }

  test('a read-only run with a tool error gets both extractions', async () => {
    const calls = [...READS, { name: 'read_file', success: false }]
    expect(await setup(calls).run()).toEqual({ memory: 1, lesson: 1 })
  })

  test('with skip_noop_extraction off, the no-op run gets both extractions', async () => {
    expect(await setup(READS, false).run()).toEqual({ memory: 1, lesson: 1 })
  })
})
