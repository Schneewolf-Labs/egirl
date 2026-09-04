/**
 * The journal: what the session bus says, the trace store keeps -- minus the per-token noise.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentLoop } from '../../src/agent/loop'
import { endRun, publish, resetSessionEvents, startRun } from '../../src/agent/session-events'
import { journalSessionEvents } from '../../src/tracking/journal'
import { setTraceStore, TraceStore } from '../../src/tracking/traces'

function makeStore(): TraceStore {
  const dir = mkdtempSync(join(tmpdir(), 'egirl-journal-'))
  return new TraceStore(join(dir, 'traces.db'), 'verbose', 14)
}

describe('session journal', () => {
  let stop: (() => void) | undefined
  afterEach(() => {
    stop?.()
    setTraceStore(null)
    resetSessionEvents()
  })

  test('a run lands as run_start, turns, tools, run_end -- tokens are not recorded', () => {
    const store = makeStore()
    setTraceStore(store)
    stop = journalSessionEvents()

    startRun('task:j', {} as AgentLoop, 'decompress the blobs')
    publish('task:j', { t: 'reasoning', v: 'hmm' })
    publish('task:j', { t: 'token', v: 'ok' })
    publish('task:j', {
      t: 'turn',
      v: {
        model: 'qwen',
        input_tokens: 10,
        output_tokens: 3,
        duration_ms: 50,
        content: 'running it',
        thinking: 'try the C path',
        tool_calls: 'execute_command',
      },
    })
    publish('task:j', {
      t: 'tool_done',
      v: { name: 'execute_command', success: true, args: '{"command":"make"}', output: 'built' },
    })
    endRun('task:j', {
      t: 'run_end',
      v: {
        content: 'done',
        input_tokens: 10,
        output_tokens: 3,
        turns: 1,
        duration_ms: 80,
        aborted: false,
        awaiting: false,
      },
    })

    const rows = store.query({ session: 'task:j', limit: 50 }).reverse()
    expect(rows.map((r) => r.kind)).toEqual(['run_start', 'turn', 'tool', 'run_end'])
    expect(JSON.parse(rows[0]?.payload ?? '{}').message).toBe('decompress the blobs')
    expect(JSON.parse(rows[1]?.payload ?? '{}').thinking).toBe('try the C path')
    expect(rows[2]?.name).toBe('execute_command')
    expect(JSON.parse(rows[2]?.payload ?? '{}').output).toBe('built')
    expect(rows[3]?.success).toBe(1)
    expect(JSON.parse(rows[3]?.payload ?? '{}').turns).toBe(1)
  })

  test('a failed run closes with run_end carrying the error', () => {
    const store = makeStore()
    setTraceStore(store)
    stop = journalSessionEvents()
    startRun('cli:x', {} as AgentLoop, 'hi')
    endRun('cli:x', { t: 'error', v: 'server went away' })
    const rows = store.query({ session: 'cli:x', kind: 'run_end' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.success).toBe(0)
    expect(JSON.parse(rows[0]?.payload ?? '{}').error).toBe('server went away')
  })

  test('unsubscribing stops the journal', () => {
    const store = makeStore()
    setTraceStore(store)
    const off = journalSessionEvents()
    off()
    startRun('cli:y', {} as AgentLoop, 'hi')
    expect(store.query({ session: 'cli:y' })).toHaveLength(0)
  })
})
