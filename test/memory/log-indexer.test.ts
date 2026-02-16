import { describe, expect, test } from 'bun:test'
import { chunkDailyLog } from '../../src/memory/log-indexer'

describe('chunkDailyLog', () => {
  test('returns empty array for empty content', () => {
    expect(chunkDailyLog('2026-02-16', '')).toEqual([])
    expect(chunkDailyLog('2026-02-16', '  \n  ')).toEqual([])
  })

  test('chunks a single log entry', () => {
    const content = '[2026-02-16T10:00:00.000Z] SET mykey [general]: some value...'
    const chunks = chunkDailyLog('2026-02-16', content)

    expect(chunks).toHaveLength(1)
    expect(chunks[0].date).toBe('2026-02-16')
    expect(chunks[0].firstTimestamp).toBe('2026-02-16T10:00:00.000Z')
    expect(chunks[0].content).toContain('SET mykey')
  })

  test('groups multiple entries into one chunk when under limit', () => {
    const lines = [
      '[2026-02-16T10:00:00.000Z] SET key1 [general]: value one',
      '[2026-02-16T10:01:00.000Z] SET key2 [fact]: value two',
      '[2026-02-16T10:02:00.000Z] SET key3 [decision]: value three',
    ]
    const chunks = chunkDailyLog('2026-02-16', lines.join('\n'))

    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toContain('key1')
    expect(chunks[0].content).toContain('key3')
    expect(chunks[0].firstTimestamp).toBe('2026-02-16T10:00:00.000Z')
  })

  test('splits into multiple chunks when exceeding size limit', () => {
    // Create entries that exceed 1500 chars total
    const lines: string[] = []
    for (let i = 0; i < 30; i++) {
      lines.push(`[2026-02-16T10:${String(i).padStart(2, '0')}:00.000Z] SET key${i} [general]: ${'x'.repeat(80)}`)
    }
    const chunks = chunkDailyLog('2026-02-16', lines.join('\n'))

    expect(chunks.length).toBeGreaterThan(1)
    // Each chunk should have content
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(0)
      expect(chunk.date).toBe('2026-02-16')
    }
  })

  test('uses date as fallback timestamp when entries lack timestamps', () => {
    const content = 'some log line without a timestamp'
    const chunks = chunkDailyLog('2026-02-16', content)

    expect(chunks).toHaveLength(1)
    expect(chunks[0].firstTimestamp).toBe('2026-02-16')
  })
})
