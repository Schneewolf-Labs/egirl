import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../../src/config'
import type { RuntimeConfig } from '../../src/config/schema'
import { createProviderRegistry } from '../../src/providers'

/**
 * Compaction summaries and memory extraction run on the auxiliary model when one is configured.
 *
 * They do not need the operator model's capability, and running them there costs its slot and
 * competes for its context. The 396-character summary that turned a sixteen-search research run
 * into "fresh project scaffolded" was produced by the same 27B that was mid-task, under context
 * pressure, in the slot the task needed.
 *
 * Absent configuration, `auxiliary` is undefined and every caller falls back to the main provider —
 * the previous behaviour, unchanged.
 */

function withAux(aux?: RuntimeConfig['local']['auxiliary']): RuntimeConfig {
  const base = loadConfig()
  return { ...base, local: { ...base.local, auxiliary: aux } }
}

describe('auxiliary provider', () => {
  test('is absent unless configured', () => {
    const registry = createProviderRegistry(withAux(undefined))
    expect(registry.auxiliary).toBeUndefined()
    expect(registry.local).toBeDefined()
  })

  test('is built when configured, and is a distinct provider', () => {
    const registry = createProviderRegistry(
      withAux({ endpoint: 'http://localhost:8099', model: 'small-4b' }),
    )
    expect(registry.auxiliary).toBeDefined()
    expect(registry.auxiliary?.name).toContain('small-4b')
    expect(registry.auxiliary?.name).not.toBe(registry.local.name)
  })

  test('defaults to temperature 0 — summaries want determinism, not variety', () => {
    // Constructed without an explicit temperature; the factory pins 0 rather than inheriting
    // llama.cpp's 0.8, so the same conversation compacts the same way twice.
    const registry = createProviderRegistry(
      withAux({ endpoint: 'http://localhost:8099', model: 'small-4b' }),
    )
    expect(registry.auxiliary).toBeDefined()
  })
})
