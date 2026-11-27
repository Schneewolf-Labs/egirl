/**
 * The startup dependency summary.
 *
 * What it must get right: a down dependency is a warning (seen at the default level), an up one
 * is debug, an unconfigured one is silent, and a probe that never answers cannot hold startup.
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { RuntimeConfig } from '../../src/config'
import {
  type DependencyProbe,
  dependencyProbes,
  reportDependencies,
} from '../../src/instances/startup-probe'
import { log } from '../../src/util/logger'

const up = Bun.serve({ port: 0, fetch: () => Response.json({ data: [{ id: 'm' }] }) })
const UP = `http://127.0.0.1:${up.port}`
afterAll(() => up.stop(true))

let warned: string[] = []
let debugged: string[] = []
let spies: Array<ReturnType<typeof spyOn>> = []

beforeEach(() => {
  warned = []
  debugged = []
  spies = [
    spyOn(log, 'warn').mockImplementation((_c: string, m: string) => {
      warned.push(m)
    }),
    spyOn(log, 'debug').mockImplementation((_c: string, m: string) => {
      debugged.push(m)
    }),
    spyOn(log, 'info').mockImplementation(() => {}),
  ]
})

afterEach(() => {
  for (const spy of spies) spy.mockRestore()
})

function configWith(local: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { local: { endpoint: UP, model: 'm', ...local }, channels: {}, ...extra } as RuntimeConfig
}

describe('reportDependencies', () => {
  test('a down dependency warns with what happens without it; an up one is debug', async () => {
    await reportDependencies(
      configWith({
        auxiliary: { endpoint: 'http://127.0.0.1:1', model: 'aux' },
        embeddings: {
          provider: 'qwen3-vl',
          endpoint: 'http://127.0.0.1:2',
          model: 'e',
          dimensions: 2048,
          multimodal: true,
        },
      }),
    )

    expect(warned).toContain(
      'auxiliary http://127.0.0.1:1 down: side work will run on the operator',
    )
    expect(warned.find((m) => m.startsWith('embeddings http://127.0.0.1:2 down:'))).toContain(
      'memory falls back to keyword search',
    )
    expect(warned.some((m) => m.startsWith('operator'))).toBe(false)
    expect(debugged).toContain(`operator ${UP} up`)
  })

  test('unconfigured services print nothing', async () => {
    await reportDependencies(configWith({}, { mcp: { servers: [{ name: 's', command: 'x' }] } }))

    expect(warned).toEqual([])
    // Only the operator was probed: no auxiliary, embeddings, or stdio MCP line at any level.
    expect(debugged).toEqual([`operator ${UP} up`])
  })

  test('a down operator and MCP server are named', async () => {
    await reportDependencies(
      configWith(
        { endpoint: 'http://127.0.0.1:1' },
        { mcp: { servers: [{ name: 'wald', url: 'http://127.0.0.1:3/mcp' }] } },
      ),
    )

    expect(warned).toContain('operator http://127.0.0.1:1 down: turns will fail until it answers')
    expect(warned.find((m) => m.startsWith('mcp wald'))).toContain('down')
  })

  test('a hanging probe is cut off at the bound, and the others still report', async () => {
    const hang: DependencyProbe = {
      name: 'auxiliary',
      target: 'http://hang',
      ifDown: 'side work will run on the operator',
      probe: () => new Promise(() => {}),
    }
    const fine: DependencyProbe = {
      name: 'embeddings',
      target: 'http://fine',
      ifDown: 'x',
      probe: async () => ({ label: 'embeddings', level: 'ok', message: '' }),
    }
    const throws: DependencyProbe = {
      name: 'mcp boom',
      target: 'http://boom',
      ifDown: 'its tools will be missing until restart',
      probe: async () => {
        throw new Error('boom')
      },
    }

    const started = performance.now()
    await reportDependencies(configWith({}), { probes: [hang, fine, throws], timeoutMs: 100 })
    const elapsed = performance.now() - started

    expect(elapsed).toBeLessThan(1000)
    expect(warned).toContain('auxiliary http://hang down: side work will run on the operator')
    expect(warned).toContain('mcp boom http://boom down: its tools will be missing until restart')
    expect(debugged).toContain('embeddings http://fine up')
    expect(debugged).toContain('auxiliary: no answer within 100ms')
  })
})

describe('dependencyProbes', () => {
  test('side work on Claude has no local endpoint to probe', () => {
    const probes = dependencyProbes(configWith({ isClaude: true }))
    expect(probes).toEqual([])
  })

  test('a hosted-harness operator leaves the local endpoint doing side work', () => {
    const probes = dependencyProbes(configWith({}, { operator: { provider: 'codex' } }))
    expect(probes.map((p) => p.name)).toEqual(['local model'])
  })
})
