import { describe, expect, test } from 'bun:test'
import { createStatsTracker, StatsTracker } from '../../src/tracking/stats'

describe('StatsTracker', () => {
  test('starts with zero stats', () => {
    const tracker = new StatsTracker()
    const stats = tracker.getStats()
    expect(stats.totalRequests).toBe(0)
    expect(stats.localRequests).toBe(0)
    expect(stats.remoteRequests).toBe(0)
    expect(stats.totalCost).toBe(0)
  })

  test('records local request', () => {
    const tracker = new StatsTracker()
    tracker.recordRequest('local', 'local', 100, 50, false)

    const stats = tracker.getStats()
    expect(stats.totalRequests).toBe(1)
    expect(stats.localRequests).toBe(1)
    expect(stats.remoteRequests).toBe(0)
    expect(stats.localInputTokens).toBe(100)
    expect(stats.localOutputTokens).toBe(50)
    expect(stats.totalCost).toBe(0)
    expect(stats.savedCost).toBeGreaterThan(0) // estimated savings
  })

  test('records remote request with cost', () => {
    const tracker = new StatsTracker()
    tracker.recordRequest('remote', 'gpt-4o', 1000, 500, false)

    const stats = tracker.getStats()
    expect(stats.totalRequests).toBe(1)
    expect(stats.remoteRequests).toBe(1)
    expect(stats.remoteInputTokens).toBe(1000)
    expect(stats.remoteOutputTokens).toBe(500)
    expect(stats.totalCost).toBeGreaterThan(0)
  })

  test('tracks escalations', () => {
    const tracker = new StatsTracker()
    tracker.recordRequest('remote', 'gpt-4o', 100, 50, true)
    tracker.recordRequest('local', 'local', 100, 50, false)

    const stats = tracker.getStats()
    expect(stats.escalations).toBe(1)
  })

  test('accumulates across multiple requests', () => {
    const tracker = new StatsTracker()
    tracker.recordRequest('local', 'local', 100, 50, false)
    tracker.recordRequest('local', 'local', 200, 100, false)
    tracker.recordRequest('remote', 'gpt-4o', 300, 150, true)

    const stats = tracker.getStats()
    expect(stats.totalRequests).toBe(3)
    expect(stats.localRequests).toBe(2)
    expect(stats.remoteRequests).toBe(1)
    expect(stats.totalInputTokens).toBe(600)
    expect(stats.totalOutputTokens).toBe(300)
    expect(stats.escalations).toBe(1)
  })

  test('getStats returns a copy', () => {
    const tracker = new StatsTracker()
    tracker.recordRequest('local', 'local', 100, 50, false)

    const stats1 = tracker.getStats()
    const stats2 = tracker.getStats()
    expect(stats1).toEqual(stats2)
    expect(stats1).not.toBe(stats2) // different object references
  })

  test('reset clears all stats', () => {
    const tracker = new StatsTracker()
    tracker.recordRequest('local', 'local', 100, 50, false)
    tracker.recordRequest('remote', 'gpt-4o', 200, 100, true)

    tracker.reset()
    const stats = tracker.getStats()
    expect(stats.totalRequests).toBe(0)
    expect(stats.totalCost).toBe(0)
    expect(stats.savedCost).toBe(0)
  })

  test('formatSummary includes key info', () => {
    const tracker = new StatsTracker()
    tracker.recordRequest('local', 'local', 1000, 500, false)
    tracker.recordRequest('remote', 'gpt-4o', 2000, 1000, true)

    const summary = tracker.formatSummary()
    expect(summary).toContain('Total Requests: 2')
    expect(summary).toContain('Local: 1')
    expect(summary).toContain('Remote: 1')
    expect(summary).toContain('Escalations: 1')
    expect(summary).toContain('Saved:')
  })

  test('formatSummary handles zero requests', () => {
    const tracker = new StatsTracker()
    const summary = tracker.formatSummary()
    expect(summary).toContain('Total Requests: 0')
    expect(summary).toContain('(0%)')
  })
})

describe('createStatsTracker', () => {
  test('creates a new StatsTracker instance', () => {
    const tracker = createStatsTracker()
    expect(tracker).toBeInstanceOf(StatsTracker)
  })
})
