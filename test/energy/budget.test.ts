import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EnergyBudget } from '../../src/energy'

describe('EnergyBudget', () => {
  let tmpDir: string
  let budget: EnergyBudget

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'egirl-energy-test-'))
    budget = new EnergyBudget(join(tmpDir, 'energy.db'))
  })

  afterEach(() => {
    budget.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('starts at max energy', () => {
    const state = budget.getState()
    expect(state.current).toBe(20)
    expect(state.max).toBe(20)
  })

  test('spend deducts energy for known tools', () => {
    const result = budget.spend('read_file')
    expect(result.allowed).toBe(true)
    expect(result.cost).toBe(0.5)
    expect(result.remaining).toBe(19.5)
  })

  test('spend blocks when insufficient energy', () => {
    // Drain energy with expensive tool calls
    for (let i = 0; i < 4; i++) {
      budget.spend('execute_command') // 4.0 each
    }
    // 20 - 16 = 4.0 remaining
    const result = budget.spend('code_agent') // costs 5.0
    expect(result.allowed).toBe(false)
    expect(result.cost).toBe(5.0)
    expect(result.reason).toContain('Insufficient energy')
  })

  test('check does not deduct energy', () => {
    const before = budget.getState().current
    const check = budget.check('execute_command')
    const after = budget.getState().current

    expect(check.allowed).toBe(true)
    expect(check.cost).toBe(4.0)
    expect(after).toBe(before)
  })

  test('read-only tools are cheap', () => {
    const result = budget.spend('read_file')
    expect(result.cost).toBe(0.5)
  })

  test('destructive tools are expensive', () => {
    const result = budget.spend('gh_pr_create')
    expect(result.cost).toBe(6.0)
  })

  test('unknown tools use default cost', () => {
    const result = budget.spend('some_unknown_tool')
    expect(result.cost).toBe(2.0)
  })

  test('getHistory returns recent spends', () => {
    budget.spend('read_file')
    budget.spend('write_file')

    const history = budget.getHistory()
    expect(history.length).toBe(2)
    expect(history[0]?.toolName).toBe('write_file') // most recent first
    expect(history[1]?.toolName).toBe('read_file')
  })

  test('custom config changes max energy and regen rate', () => {
    const custom = new EnergyBudget(join(tmpDir, 'custom.db'), {
      maxEnergy: 10,
      regenPerHour: 5,
    })

    const state = custom.getState()
    expect(state.current).toBe(10)
    expect(state.max).toBe(10)
    expect(state.regenPerHour).toBe(5)

    custom.close()
  })

  test('disabled budget allows everything', () => {
    const disabled = new EnergyBudget(join(tmpDir, 'disabled.db'), { enabled: false })

    // Should always allow
    const result = disabled.spend('gh_pr_create')
    expect(result.allowed).toBe(true)
    expect(result.cost).toBe(0) // no cost when disabled

    const check = disabled.check('gh_pr_create')
    expect(check.allowed).toBe(true)

    disabled.close()
  })

  test('state persists across instances', () => {
    const dbPath = join(tmpDir, 'persist.db')
    const b1 = new EnergyBudget(dbPath)
    b1.spend('execute_command') // -4.0
    b1.close()

    const b2 = new EnergyBudget(dbPath)
    const state = b2.getState()
    expect(state.current).toBeLessThan(20)
    b2.close()
  })
})
