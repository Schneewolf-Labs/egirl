import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EnergyBudget } from '../../src/energy'
import { ToolExecutor } from '../../src/tools/executor'
import type { Tool } from '../../src/tools/types'

function stubTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `stub ${name}`,
      parameters: { type: 'object', properties: {} },
    },
    execute: async () => ({ success: true, output: `${name} done` }),
  }
}

describe('ToolExecutor batch energy pre-check', () => {
  let tmpDir: string
  let budget: EnergyBudget

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'egirl-executor-energy-'))
    budget = new EnergyBudget(join(tmpDir, 'energy.db'), { maxEnergy: 10 })
  })

  afterEach(() => {
    budget.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('blocks entire batch when total cost exceeds budget', async () => {
    const exec = new ToolExecutor()
    exec.register(stubTool('execute_command')) // cost 4.0
    exec.register(stubTool('gh_pr_create')) // cost 6.0
    exec.register(stubTool('read_file')) // cost 0.5
    exec.setEnergy(budget)
    exec.setExecutionContext('autonomous')

    // Total: 4.0 + 6.0 + 0.5 = 10.5, budget = 10
    const results = await exec.executeAll(
      [
        { id: 'a', name: 'execute_command', arguments: {} },
        { id: 'b', name: 'gh_pr_create', arguments: {} },
        { id: 'c', name: 'read_file', arguments: {} },
      ],
      '/tmp',
    )

    // All three should be blocked
    expect(results.size).toBe(3)
    for (const [, result] of results) {
      expect(result.success).toBe(false)
      expect(result.output).toContain('Energy budget exceeded for batch')
    }

    // Energy should not have been spent
    const state = budget.getState()
    expect(state.current).toBe(10)
  })

  test('allows batch when total cost fits budget', async () => {
    const exec = new ToolExecutor()
    exec.register(stubTool('read_file')) // cost 0.5
    exec.register(stubTool('git_status')) // cost 0.5
    exec.setEnergy(budget)
    exec.setExecutionContext('autonomous')

    // Total: 0.5 + 0.5 = 1.0, budget = 10
    const results = await exec.executeAll(
      [
        { id: 'a', name: 'read_file', arguments: {} },
        { id: 'b', name: 'git_status', arguments: {} },
      ],
      '/tmp',
    )

    expect(results.size).toBe(2)
    for (const [, result] of results) {
      expect(result.success).toBe(true)
    }
  })

  test('skips batch pre-check in interactive context', async () => {
    // Drain budget to 1.0
    for (let i = 0; i < 9; i++) {
      budget.spend('memory_set') // 1.0 each = 9.0 spent, 1.0 left
    }

    const exec = new ToolExecutor()
    exec.register(stubTool('execute_command')) // cost 4.0
    exec.register(stubTool('write_file')) // cost 2.5
    exec.setEnergy(budget)
    exec.setExecutionContext('interactive')

    // Total: 6.5, budget = 1.0, but interactive bypasses energy checks
    const results = await exec.executeAll(
      [
        { id: 'a', name: 'execute_command', arguments: {} },
        { id: 'b', name: 'write_file', arguments: {} },
      ],
      '/tmp',
    )

    expect(results.size).toBe(2)
    for (const [, result] of results) {
      expect(result.success).toBe(true)
    }
  })

  test('single-tool batch skips pre-check and uses per-tool check', async () => {
    // Drain to 3.0
    for (let i = 0; i < 7; i++) {
      budget.spend('memory_set') // 1.0 each = 7.0 spent, 3.0 left
    }

    const exec = new ToolExecutor()
    exec.register(stubTool('execute_command')) // cost 4.0
    exec.setEnergy(budget)
    exec.setExecutionContext('autonomous')

    // Single tool in batch — falls through to individual execute() check
    const results = await exec.executeAll(
      [{ id: 'a', name: 'execute_command', arguments: {} }],
      '/tmp',
    )

    expect(results.size).toBe(1)
    const result = results.get('a')
    expect(result?.success).toBe(false)
    expect(result?.output).toContain('Energy budget exceeded')
  })
})
