import { describe, expect, it } from 'bun:test'
import { TokenBudgetTracker } from '../../src/agent/token-budget'

describe('TokenBudgetTracker', () => {
  it('starts with zero utilization', () => {
    const tracker = new TokenBudgetTracker(32768)
    const status = tracker.status()

    expect(status.contextLength).toBe(32768)
    expect(status.lastInputTokens).toBe(0)
    expect(status.utilization).toBe(0)
    expect(status.level).toBe('ok')
    expect(status.totalInputTokens).toBe(0)
    expect(status.totalOutputTokens).toBe(0)
  })

  it('records token usage and computes utilization', () => {
    const tracker = new TokenBudgetTracker(10000)
    const status = tracker.record(5000, 200)

    expect(status.lastInputTokens).toBe(5000)
    expect(status.utilization).toBe(0.5)
    expect(status.level).toBe('ok')
    expect(status.totalInputTokens).toBe(5000)
    expect(status.totalOutputTokens).toBe(200)
  })

  it('accumulates total tokens across multiple records', () => {
    const tracker = new TokenBudgetTracker(10000)
    tracker.record(3000, 100)
    const status = tracker.record(5000, 200)

    // lastInputTokens reflects the most recent call
    expect(status.lastInputTokens).toBe(5000)
    // totals accumulate
    expect(status.totalInputTokens).toBe(8000)
    expect(status.totalOutputTokens).toBe(300)
  })

  it('classifies utilization as high at 75%', () => {
    const tracker = new TokenBudgetTracker(10000)
    const status = tracker.record(7500, 100)

    expect(status.level).toBe('high')
  })

  it('classifies utilization as critical at 90%', () => {
    const tracker = new TokenBudgetTracker(10000)
    const status = tracker.record(9000, 100)

    expect(status.level).toBe('critical')
  })

  it('classifies utilization as ok below 75%', () => {
    const tracker = new TokenBudgetTracker(10000)
    const status = tracker.record(7499, 100)

    expect(status.level).toBe('ok')
  })

  describe('shouldWarnHigh', () => {
    it('returns true once when high threshold is first crossed', () => {
      const tracker = new TokenBudgetTracker(10000)
      tracker.record(7500, 100)

      expect(tracker.shouldWarnHigh()).toBe(true)
      expect(tracker.shouldWarnHigh()).toBe(false)
    })

    it('returns false when below threshold', () => {
      const tracker = new TokenBudgetTracker(10000)
      tracker.record(5000, 100)

      expect(tracker.shouldWarnHigh()).toBe(false)
    })

    it('triggers on critical utilization too', () => {
      const tracker = new TokenBudgetTracker(10000)
      tracker.record(9500, 100)

      expect(tracker.shouldWarnHigh()).toBe(true)
    })
  })

  describe('shouldWarnCritical', () => {
    it('returns true once when critical threshold is first crossed', () => {
      const tracker = new TokenBudgetTracker(10000)
      tracker.record(9000, 100)

      expect(tracker.shouldWarnCritical()).toBe(true)
      expect(tracker.shouldWarnCritical()).toBe(false)
    })

    it('returns false when below critical threshold', () => {
      const tracker = new TokenBudgetTracker(10000)
      tracker.record(7500, 100)

      expect(tracker.shouldWarnCritical()).toBe(false)
    })
  })

  describe('setContextLength', () => {
    it('updates context length and recalculates utilization', () => {
      const tracker = new TokenBudgetTracker(10000)
      tracker.record(8000, 100)

      expect(tracker.status().utilization).toBe(0.8)
      expect(tracker.status().level).toBe('high')

      // Switching to a larger context (e.g., local -> remote)
      tracker.setContextLength(200000)

      expect(tracker.status().utilization).toBe(8000 / 200000)
      expect(tracker.status().level).toBe('ok')
    })
  })

  it('handles zero context length without crashing', () => {
    const tracker = new TokenBudgetTracker(0)
    const status = tracker.record(1000, 100)

    expect(status.utilization).toBe(0)
    expect(status.level).toBe('ok')
  })

  it('uses lastInputTokens for utilization, not totals', () => {
    const tracker = new TokenBudgetTracker(10000)

    // First turn uses 3000 tokens
    tracker.record(3000, 100)
    expect(tracker.status().utilization).toBe(0.3)

    // Second turn: prompt grew to 5000 tokens (includes previous messages)
    tracker.record(5000, 200)
    expect(tracker.status().utilization).toBe(0.5)

    // Third turn: prompt shrank after context trimming
    tracker.record(2000, 100)
    expect(tracker.status().utilization).toBe(0.2)
  })
})
