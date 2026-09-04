/**
 * Token budget tracker — monitors context utilization across turns
 * and signals when the loop is running low on context window budget.
 *
 * Uses input_tokens from provider responses as the real prompt size,
 * compared against the context window length to compute utilization.
 */

import { log } from '../util/logger'
import { type AgentContext, addMessage } from './context'
import type { AgentEventHandler } from './events'

export type BudgetLevel = 'ok' | 'high' | 'critical'

/** Utilization thresholds (fraction of context window) */
const HIGH_THRESHOLD = 0.75
const CRITICAL_THRESHOLD = 0.9

export interface BudgetStatus {
  /** Current context window size in tokens */
  contextLength: number
  /** Prompt tokens from the last inference call */
  lastInputTokens: number
  /** Fraction of context used (0–1) */
  utilization: number
  /** Budget level based on utilization thresholds */
  level: BudgetLevel
  /** Total input tokens accumulated across all turns */
  totalInputTokens: number
  /** Total output tokens accumulated across all turns */
  totalOutputTokens: number
}

export class TokenBudgetTracker {
  private contextLength: number
  private lastInputTokens = 0
  private totalInput = 0
  private totalOutput = 0
  private warnedHigh = false
  private warnedCritical = false

  constructor(contextLength: number) {
    this.contextLength = contextLength
  }

  /**
   * Record token usage from a provider response.
   * Returns the updated budget status.
   */
  record(inputTokens: number, outputTokens: number): BudgetStatus {
    this.lastInputTokens = inputTokens
    this.totalInput += inputTokens
    this.totalOutput += outputTokens
    return this.status()
  }

  /**
   * Update the context length (e.g., after switching between local/remote providers).
   */
  setContextLength(contextLength: number): void {
    this.contextLength = contextLength
  }

  /**
   * Get the current budget status.
   */
  status(): BudgetStatus {
    const utilization = this.contextLength > 0 ? this.lastInputTokens / this.contextLength : 0

    return {
      contextLength: this.contextLength,
      lastInputTokens: this.lastInputTokens,
      utilization,
      level: classifyUtilization(utilization),
      totalInputTokens: this.totalInput,
      totalOutputTokens: this.totalOutput,
    }
  }

  /**
   * Check if the high threshold was just crossed for the first time.
   * Returns true once, then returns false for subsequent calls.
   */
  shouldWarnHigh(): boolean {
    if (this.warnedHigh) return false
    const { level } = this.status()
    if (level === 'high' || level === 'critical') {
      this.warnedHigh = true
      return true
    }
    return false
  }

  /**
   * Check if the critical threshold was just crossed for the first time.
   * Returns true once, then returns false for subsequent calls.
   */
  shouldWarnCritical(): boolean {
    if (this.warnedCritical) return false
    const { level } = this.status()
    if (level === 'critical') {
      this.warnedCritical = true
      return true
    }
    return false
  }
}

function classifyUtilization(utilization: number): BudgetLevel {
  if (utilization >= CRITICAL_THRESHOLD) return 'critical'
  if (utilization >= HIGH_THRESHOLD) return 'high'
  return 'ok'
}

/**
 * Record a turn's token usage and surface threshold crossings:
 * logs, fires the budget event, and at
 * the critical level injects a wrap-up notice into the conversation.
 */
export function reportTokenBudget(args: {
  tracker: TokenBudgetTracker
  inputTokens: number
  outputTokens: number
  context: AgentContext
  events?: AgentEventHandler
}): void {
  const { tracker, inputTokens, outputTokens, context, events } = args
  const status = tracker.record(inputTokens, outputTokens)

  if (tracker.shouldWarnCritical()) {
    log.warn(
      'agent',
      `Token budget critical: ${Math.round(status.utilization * 100)}% of ${status.contextLength}t context used`,
    )
    events?.onTokenBudgetWarning?.('critical', status)
    addMessage(context, {
      role: 'user',
      content:
        '[System: Context window is nearly full. Wrap up your current task and provide a final response. Avoid further tool calls unless absolutely necessary.]',
    })
  } else if (tracker.shouldWarnHigh()) {
    log.info(
      'agent',
      `Token budget high: ${Math.round(status.utilization * 100)}% of ${status.contextLength}t context used`,
    )
    events?.onTokenBudgetWarning?.('high', status)
  }
}
