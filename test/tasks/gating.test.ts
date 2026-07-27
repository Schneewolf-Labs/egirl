import { describe, expect, test } from 'bun:test'
import type { RuntimeConfig } from '../../src/config'
import { taskRunnerEnabled, taskRunnerOffReason } from '../../src/tasks/gating'

/**
 * The confusing state this guards: `[tasks] enabled` defaults to TRUE while `[tools] tasks`
 * defaults to FALSE, so a fully populated `[tasks]` section is inert by default and the API
 * answered a bare "tasks disabled" naming neither flag. Found the hard way.
 */
function cfg(tasksEnabled: boolean, toolsTasks: boolean): RuntimeConfig {
  return {
    tasks: { enabled: tasksEnabled },
    tools: { tasks: toolsTasks },
  } as unknown as RuntimeConfig
}

describe('task runner gating', () => {
  test('on when the store exists and both flags agree', () => {
    expect(taskRunnerEnabled(cfg(true, true), true)).toBe(true)
    expect(taskRunnerOffReason(cfg(true, true), true)).toBeUndefined()
  })

  test('off without a store, and says so', () => {
    expect(taskRunnerEnabled(cfg(true, true), false)).toBe(false)
    expect(taskRunnerOffReason(cfg(true, true), false)).toContain('store')
  })

  test('off when [tasks] enabled is false, and names that flag', () => {
    expect(taskRunnerEnabled(cfg(false, true), true)).toBe(false)
    expect(taskRunnerOffReason(cfg(false, true), true)).toContain('[tasks] enabled')
  })

  test('the default trap: tasks.enabled true but tools.tasks false names the REAL flag', () => {
    expect(taskRunnerEnabled(cfg(true, false), true)).toBe(false)
    const why = taskRunnerOffReason(cfg(true, false), true)
    expect(why).toContain('[tools] tasks')
    // and explains that it gates the whole section, which is the non-obvious part
    expect(why).toContain('gates')
  })

  test('the store check takes precedence, so the reason is the most fundamental one', () => {
    expect(taskRunnerOffReason(cfg(false, false), false)).toContain('store')
  })
})
