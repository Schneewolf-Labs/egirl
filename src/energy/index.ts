/**
 * Energy budget system.
 *
 * Inspired by Hexis: constrains autonomous agent actions by tracking
 * energy that regenerates over time. Actions cost energy based on their
 * situational impact (irreversibility, social exposure), not compute cost.
 *
 * Key design:
 * - The system sets costs, not the agent (prevents gaming)
 * - Read-only actions are cheap, destructive/social actions are expensive
 * - Energy regenerates at a fixed rate, capped at a maximum
 * - Interactive (user-initiated) actions bypass energy checks
 * - Autonomous (heartbeat/task) actions are energy-gated
 */

import { Database } from 'bun:sqlite'
import { log } from '../util/logger'
import { getToolCost } from './costs'

export { type EnergyCost, getToolCost, hasToolCost } from './costs'

export interface EnergyConfig {
  /** Maximum energy reserve. Default: 20 */
  maxEnergy: number
  /** Energy regenerated per hour. Default: 10 */
  regenPerHour: number
  /** Whether to enforce energy checks. Default: true */
  enabled: boolean
}

export const ENERGY_DEFAULTS: EnergyConfig = {
  maxEnergy: 20,
  regenPerHour: 10,
  enabled: true,
}

export interface EnergyState {
  current: number
  max: number
  lastRegenAt: number
  regenPerHour: number
}

export interface SpendResult {
  allowed: boolean
  remaining: number
  cost: number
  reason?: string
}

export class EnergyBudget {
  private db: Database
  private config: EnergyConfig

  constructor(dbPath: string, config: Partial<EnergyConfig> = {}) {
    this.config = { ...ENERGY_DEFAULTS, ...config }
    this.db = new Database(dbPath)
    this.initialize()
  }

  private initialize(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS energy_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        current REAL NOT NULL,
        max REAL NOT NULL,
        last_regen_at INTEGER NOT NULL,
        regen_per_hour REAL NOT NULL
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS energy_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        cost REAL NOT NULL,
        balance_after REAL NOT NULL,
        context TEXT,
        created_at INTEGER NOT NULL
      )
    `)

    // Seed initial state if not present
    const existing = this.db.query('SELECT id FROM energy_state WHERE id = 1').get()
    if (!existing) {
      this.db.run(
        'INSERT INTO energy_state (id, current, max, last_regen_at, regen_per_hour) VALUES (1, ?, ?, ?, ?)',
        [this.config.maxEnergy, this.config.maxEnergy, Date.now(), this.config.regenPerHour],
      )
    }

    log.debug('energy', 'Energy budget initialized')
  }

  /** Get current energy state after applying regeneration */
  getState(): EnergyState {
    this.applyRegen()
    const row = this.db
      .query('SELECT current, max, last_regen_at, regen_per_hour FROM energy_state WHERE id = 1')
      .get() as { current: number; max: number; last_regen_at: number; regen_per_hour: number }

    return {
      current: row.current,
      max: row.max,
      lastRegenAt: row.last_regen_at,
      regenPerHour: row.regen_per_hour,
    }
  }

  /**
   * Check if a tool execution can be afforded without spending.
   * Returns the cost info and whether it would be allowed.
   */
  check(toolName: string): { allowed: boolean; cost: number; current: number } {
    if (!this.config.enabled) {
      return { allowed: true, cost: 0, current: this.config.maxEnergy }
    }

    this.applyRegen()
    const state = this.readState()
    const { cost } = getToolCost(toolName)

    return {
      allowed: state.current >= cost,
      cost,
      current: state.current,
    }
  }

  /**
   * Attempt to spend energy for a tool execution.
   * Returns whether the spend was allowed and the remaining balance.
   */
  spend(toolName: string, context?: string): SpendResult {
    if (!this.config.enabled) {
      return { allowed: true, remaining: this.config.maxEnergy, cost: 0 }
    }

    this.applyRegen()
    const state = this.readState()
    const { cost } = getToolCost(toolName)

    if (state.current < cost) {
      log.debug(
        'energy',
        `Insufficient energy for ${toolName}: need ${cost}, have ${state.current.toFixed(1)}`,
      )
      return {
        allowed: false,
        remaining: state.current,
        cost,
        reason: `Insufficient energy: ${toolName} costs ${cost}, current balance is ${state.current.toFixed(1)}`,
      }
    }

    const newBalance = state.current - cost
    this.db.run('UPDATE energy_state SET current = ? WHERE id = 1', [newBalance])

    // Record in ledger
    this.db.run(
      'INSERT INTO energy_ledger (tool_name, cost, balance_after, context, created_at) VALUES (?, ?, ?, ?, ?)',
      [toolName, cost, newBalance, context ?? null, Date.now()],
    )

    log.debug('energy', `Spent ${cost} energy on ${toolName} (${newBalance.toFixed(1)} remaining)`)

    return { allowed: true, remaining: newBalance, cost }
  }

  /**
   * Get recent energy ledger entries for diagnostics.
   */
  getHistory(limit = 20): Array<{
    toolName: string
    cost: number
    balanceAfter: number
    context: string | null
    createdAt: number
  }> {
    const rows = this.db
      .query(
        'SELECT tool_name, cost, balance_after, context, created_at FROM energy_ledger ORDER BY created_at DESC LIMIT ?',
      )
      .all(limit) as Array<{
      tool_name: string
      cost: number
      balance_after: number
      context: string | null
      created_at: number
    }>

    return rows.map((r) => ({
      toolName: r.tool_name,
      cost: r.cost,
      balanceAfter: r.balance_after,
      context: r.context,
      createdAt: r.created_at,
    }))
  }

  /** Apply time-based regeneration */
  private applyRegen(): void {
    const state = this.readState()
    const now = Date.now()
    const elapsedHours = (now - state.lastRegenAt) / 3_600_000

    if (elapsedHours < 0.01) return // Skip if less than ~36 seconds

    const regen = elapsedHours * this.config.regenPerHour
    const newCurrent = Math.min(state.current + regen, this.config.maxEnergy)

    this.db.run('UPDATE energy_state SET current = ?, last_regen_at = ? WHERE id = 1', [
      newCurrent,
      now,
    ])
  }

  private readState(): { current: number; lastRegenAt: number } {
    const row = this.db
      .query('SELECT current, last_regen_at FROM energy_state WHERE id = 1')
      .get() as { current: number; last_regen_at: number }

    return { current: row.current, lastRegenAt: row.last_regen_at }
  }

  close(): void {
    this.db.close()
  }
}

export function createEnergyBudget(dbPath: string, config?: Partial<EnergyConfig>): EnergyBudget {
  return new EnergyBudget(dbPath, config)
}
