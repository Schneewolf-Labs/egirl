import { describe, expect, test } from 'bun:test'
import type { AgentLoopDeps } from '../../src/agent/types'
import type { Operator } from '../../src/operator/types'
import {
  createDiscovery,
  DISCOVERY_TOOLS,
  type DiscoveryDeps,
  discoveryExecutor,
  discoveryOutcome,
} from '../../src/tasks/discovery'
import type { TaskRunner } from '../../src/tasks/runner'
import type { TaskStore } from '../../src/tasks/store'
import type { TasksConfig } from '../../src/tasks/types'
import { createToolExecutor } from '../../src/tools/executor'
import type { Tool } from '../../src/tools/types'
import { makeConfig, makeWorkspace } from '../agent/helpers'

/**
 * Observed on Jaeger: discovery ran with the whole toolbelt (131 shell commands, 4 task
 * cancellations, a memory write in two days), kept going with 9 proposals unread, and logged
 * "Discovery complete" whether or not it had got anywhere.
 */

const tool = (name: string): Tool => ({
  definition: { name, description: name, parameters: { type: 'object', properties: {} } },
  async execute() {
    return { success: true, output: name }
  },
})

const FULL = [
  'execute_command',
  'write_file',
  'task_cancel',
  'memory_set',
  'code_agent',
  ...DISCOVERY_TOOLS,
]

function setup(proposed: number, afterRun = proposed) {
  const executor = createToolExecutor()
  for (const name of FULL) executor.register(tool(name))
  let count = proposed
  const seen: { tools?: string[]; runs: number } = { runs: 0 }
  const deps = {
    config: makeConfig(makeWorkspace()),
    tasksConfig: { idleThresholdMs: 0 } as TasksConfig,
    store: {
      list: () => Array.from({ length: count }, () => ({ name: 'p', description: 'd' })),
    } as unknown as TaskStore,
    runner: {
      isIdle: () => true,
      getLastInteractionAt: () => Date.now() - 1000,
    } as unknown as TaskRunner,
    toolExecutor: executor,
    localProvider: {
      name: 'stub',
      chat: async () => ({ content: '', usage: { input_tokens: 0, output_tokens: 0 } }),
    },
    memory: undefined,
    buildOperator: (agentDeps: AgentLoopDeps) =>
      ({
        async run() {
          seen.runs++
          seen.tools = agentDeps.toolExecutor.getDefinitions().map((d) => d.name)
          count = afterRun
          return {
            content: 'ok',
            provider: 'stub',
            usage: { input_tokens: 0, output_tokens: 0 },
            turns: 4,
          }
        },
      }) as unknown as Operator,
  } as unknown as DiscoveryDeps
  const discovery = createDiscovery(deps)
  const tick = (): Promise<void> =>
    (discovery as unknown as { maybeRun(): Promise<void> }).maybeRun()
  return { discovery, seen, tick, executor }
}

describe('discovery', () => {
  test('a pass sees only read-only tools and task_propose', async () => {
    const { discovery, seen } = setup(0, 2)
    await discovery.run()
    expect(seen.tools).toContain('task_propose')
    expect(seen.tools).toContain('git_status')
    for (const name of [
      'execute_command',
      'write_file',
      'task_cancel',
      'memory_set',
      'code_agent',
    ]) {
      expect(seen.tools).not.toContain(name)
    }
  })

  test('the cut-down executor keeps only what the instance actually has', () => {
    const full = createToolExecutor()
    full.register(tool('read_file'))
    full.register(tool('execute_command'))
    expect(
      discoveryExecutor(full)
        .getDefinitions()
        .map((d) => d.name),
    ).toEqual(['read_file'])
  })

  test('skipped while a pass worth of proposals waits for review', async () => {
    const waiting = setup(3)
    await waiting.tick()
    expect(waiting.seen.runs).toBe(0)
    const few = setup(2)
    await few.tick()
    expect(few.seen.runs).toBe(1)
  })

  test('the log says how a pass ended', () => {
    expect(discoveryOutcome(2, 6, false)).toBe('Discovery finished in 6 turns: proposed 2')
    expect(discoveryOutcome(0, 4, false)).toBe('Discovery finished in 4 turns: nothing proposed')
    expect(discoveryOutcome(0, 10, true)).toBe('Discovery hit its 10-turn cap: nothing proposed')
  })
})
