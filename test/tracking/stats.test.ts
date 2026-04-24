import { describe, expect, test } from 'bun:test'
import { createStatsTracker, StatsTracker } from '../../src/tracking/stats'

describe('StatsTracker', () => {
  test('starts with zero stats', () => {
    const tracker = new StatsTracker()
    const stats = tracker.getStats()
    expect(stats.totalRequests).toBe(0)
    expect(stats.totalInputTokens).toBe(0)
    expect(stats.totalOutputTokens).toBe(0)
  })

  test('records a request', () => {
    const tracker = new StatsTracker()
    tracker.recordRequest('llamacpp/qwen3', 100, 50)

    const stats = tracker.getStats()
    expect(stats.totalRequests).toBe(1)
    expect(stats.totalInputTokens).toBe(100)
    expect(stats.totalOutputTokens).toBe(50)
  })

  test('accumulates across multiple requests', () => {
    const tracker = new StatsTracker()
    tracker.recordRequest('llamacpp/qwen3', 100, 50)
    tracker.recordRequest('llamacpp/qwen3', 200, 100)
    tracker.recordRequest('llamacpp/qwen3', 300, 150)

    const stats = tracker.getStats()
    expect(stats.totalRequests).toBe(3)
    expect(stats.totalInputTokens).toBe(600)
    expect(stats.totalOutputTokens).toBe(300)
  })

  test('getStats returns a copy', () => {
    const tracker = new StatsTracker()
    tracker.recordRequest('llamacpp/qwen3', 100, 50)

    const stats1 = tracker.getStats()
    const stats2 = tracker.getStats()
    expect(stats1).toEqual(stats2)
    expect(stats1).not.toBe(stats2)
  })

  test('reset clears all stats', () => {
    const tracker = new StatsTracker()
    tracker.recordRequest('llamacpp/qwen3', 100, 50)
    tracker.recordRequest('llamacpp/qwen3', 200, 100)

    tracker.reset()
    const stats = tracker.getStats()
    expect(stats.totalRequests).toBe(0)
    expect(stats.totalInputTokens).toBe(0)
    expect(stats.totalOutputTokens).toBe(0)
  })

  test('formatSummary includes key info', () => {
    const tracker = new StatsTracker()
    tracker.recordRequest('llamacpp/qwen3', 1000, 500)
    tracker.recordRequest('llamacpp/qwen3', 2000, 1000)

    const summary = tracker.formatSummary()
    expect(summary).toContain('Requests: 2')
    expect(summary).toContain('3000')
    expect(summary).toContain('1500')
  })

  test('formatSummary handles zero requests', () => {
    const tracker = new StatsTracker()
    const summary = tracker.formatSummary()
    expect(summary).toContain('Requests: 0')
  })
})

describe('createStatsTracker', () => {
  test('creates a new StatsTracker instance', () => {
    const tracker = createStatsTracker()
    expect(tracker).toBeInstanceOf(StatsTracker)
  })
})
