/**
 * Memory starts without embeddings, on keyword search.
 *
 * It used to be off entirely, while memory_search and memory_get were still offered as stubs
 * that only answered "not initialized".
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemory } from '../src/bootstrap'
import type { RuntimeConfig } from '../src/config'

const configWithout = (): RuntimeConfig =>
  ({
    workspace: { path: mkdtempSync(join(tmpdir(), 'kw-memory-')) },
    local: {},
  }) as unknown as RuntimeConfig

describe('createMemory', () => {
  test('without embeddings, memory exists and keyword search finds what was stored', async () => {
    const memory = createMemory(configWithout())
    expect(memory).toBeDefined()
    await memory?.set('bxgen-status', 'bxgen.py roundtrip passes; keychain.py still a stub')
    const hits = (await memory?.searchHybrid('keychain')) ?? []
    expect(hits.map((h) => h.memory.key)).toContain('bxgen-status')
  })
})
