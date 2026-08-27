import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTraceStore, TraceStore, trace } from '../../src/tracking/traces'

function makeStore(verbosity: 'verbose' | 'metadata' = 'verbose', retentionDays = 14): TraceStore {
  const dir = mkdtempSync(join(tmpdir(), 'egirl-traces-'))
  return new TraceStore(join(dir, 'traces.db'), verbosity, retentionDays)
}

afterEach(() => setTraceStore(null))

describe('TraceStore', () => {
  test('records and queries turn events with thinking payloads', () => {
    const store = makeStore()
    store.record({
      session: 'task:abc',
      kind: 'turn',
      name: 'qwen',
      tokensIn: 1000,
      tokensOut: 200,
      durationMs: 1234,
      payload: { content: 'the answer', thinking: 'let me reason about the RFD header' },
    })
    const rows = store.query({ session: 'task:abc' })
    expect(rows).toHaveLength(1)
    const payload = JSON.parse(rows[0]?.payload ?? '{}')
    expect(payload.thinking).toContain('RFD header')
    expect(rows[0]?.tokens_in).toBe(1000)
    store.close()
  })

  test('FTS search finds payload text', () => {
    const store = makeStore()
    store.record({ kind: 'tool', name: 'execute_command', payload: { args: 'xxd loco.exe' } })
    store.record({ kind: 'tool', name: 'read_file', payload: { args: 'NOTES.md' } })
    const hits = store.query({ q: 'loco.exe' })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.name).toBe('execute_command')
    store.close()
  })

  test('metadata verbosity stores sizes, not bodies', () => {
    const store = makeStore('metadata')
    store.record({ kind: 'turn', payload: { thinking: 'secret reasoning here' } })
    const rows = store.query({})
    const payload = JSON.parse(rows[0]?.payload ?? '{}')
    expect(payload.thinking).toBe('[21 chars]')
    expect(rows[0]?.payload).not.toContain('secret')
    store.close()
  })

  test('oversized payload fields are capped, not dropped', () => {
    const store = makeStore()
    store.record({ kind: 'tool', payload: { output: 'x'.repeat(100000) } })
    const rows = store.query({})
    const payload = JSON.parse(rows[0]?.payload ?? '{}')
    expect(payload.output.length).toBeLessThan(70000)
    expect(payload.output).toContain('[truncated')
    store.close()
  })

  test('module trace() is a no-op when uninitialized and records when set', () => {
    setTraceStore(null)
    trace({ kind: 'turn', payload: { content: 'dropped silently' } }) // must not throw
    const store = makeStore()
    setTraceStore(store)
    trace({ kind: 'aux', name: 'compaction', payload: { summary: 'condensed' } })
    expect(store.query({ kind: 'aux' })).toHaveLength(1)
    store.close()
  })
})
