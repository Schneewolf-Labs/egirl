/**
 * Doctor with the operator down.
 *
 * The auxiliary, embeddings and MCP services are separate processes on their own ports. Doctor
 * used to skip all of them once the operator failed, which hid a dead auxiliary behind the one
 * failure it did report. Real servers and closed ports, as in the preflight tests.
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { runDoctor } from '../../src/commands/doctor'
import type { RuntimeConfig } from '../../src/config'

const CLOSED = 'http://127.0.0.1:1'

const embeddings = Bun.serve({ port: 0, fetch: () => Response.json({ status: 'healthy' }) })
afterAll(() => embeddings.stop(true))

function config(): RuntimeConfig {
  return {
    source: {},
    local: {
      endpoint: CLOSED,
      model: 'op',
      auxiliary: { endpoint: 'http://127.0.0.1:2', model: 'aux' },
      embeddings: {
        provider: 'qwen3-vl',
        endpoint: `http://127.0.0.1:${embeddings.port}`,
        model: 'emb',
        dimensions: 2048,
        multimodal: true,
      },
    },
    mcp: { servers: [{ name: 'wald', url: 'http://127.0.0.1:3/mcp' }] },
    tools: { codeAgent: true },
    channels: {},
    permissionSupervisor: { mode: 'auto', defaultAction: 'deny' },
  } as unknown as RuntimeConfig
}

let lines: string[] = []
let logSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  lines = []
  logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes
    lines.push(String(args[0] ?? '').replace(/\x1b\[[0-9;]*m/g, ''))
  })
})

afterEach(() => {
  logSpy.mockRestore()
  // Doctor sets a failing exit code on purpose; it must not leak into the test run's own.
  process.exitCode = 0
})

function line(label: string): string | undefined {
  return lines.find((l) => l.trim().split(' ').slice(1).join(' ').startsWith(label))
}

describe('doctor with the operator down', () => {
  test('still probes every independent service', async () => {
    await runDoctor(config())

    expect(line('local model')).toContain('fail')
    expect(line('auxiliary model')).toContain('fail')
    expect(line('auxiliary model')).not.toContain('skip')
    expect(line('embeddings')).toContain('ok')
    expect(line('mcp wald')).toContain('fail')
  })

  test('skips the served-model check, which needs the operator, and says why', async () => {
    await runDoctor(config())

    const served = line('served model')
    expect(served).toContain('skip')
    expect(served).toContain(`${CLOSED} is unreachable`)
    // A skip is not an issue: the count is the fail lines alone.
    const fails = lines.filter((l) => l.trim().startsWith('fail ')).length
    expect(lines.some((l) => l.includes(`${fails} issue(s) found`))).toBe(true)
  })

  test('the endpoint line claims only that it is configured', async () => {
    await runDoctor(config())

    expect(line('endpoint')).toContain(`ok endpoint configured: ${CLOSED}`)
    // The connectivity line names the URL it failed to reach.
    expect(line('local model')).toContain(CLOSED)
  })
})
