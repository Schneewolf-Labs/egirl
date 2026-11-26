import { afterEach, describe, expect, test } from 'bun:test'
import { createCLIEventHandler } from '../../src/channels/cli-events'
import { visibleWidth } from '../../src/channels/cli-line'
import type { Phase, StatusLine } from '../../src/channels/cli-status'

const realWrite = process.stdout.write.bind(process.stdout)
let captured = ''

afterEach(() => {
  process.stdout.write = realWrite
})

describe('CLI tool progress', () => {
  test('each code agent action is a line under the call, and the latest is on the status', () => {
    captured = ''
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += String(chunk)
      return true
    }) as typeof process.stdout.write
    const statuses: string[] = []
    const status: StatusLine = {
      set: (phase: Phase, detail?: string) => statuses.push(`${phase}:${detail ?? ''}`),
      clear: () => {},
      stop: () => {},
    }
    const { handler } = createCLIEventHandler(false, status)
    handler.onToolCallStart?.([{ id: 'a', name: 'code_agent', arguments: { task: 'fix it' } }])
    handler.onToolProgress?.('a', 'code_agent', 'Bash: bun test')
    handler.onToolProgress?.('a', 'code_agent', 'Edit: src/x.ts')
    expect(captured).toContain('· Bash: bun test')
    expect(captured).toContain('· Edit: src/x.ts')
    expect(statuses.at(-1)).toBe('tool:code_agent · Edit: src/x.ts')
  })

  test('a long action is cut to the terminal width', () => {
    captured = ''
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += String(chunk)
      return true
    }) as typeof process.stdout.write
    const { handler } = createCLIEventHandler(false)
    handler.onToolProgress?.('a', 'code_agent', `Bash: ${'x'.repeat(500)}`)
    const width = process.stdout.columns || 80
    for (const line of captured.split('\n')) expect(visibleWidth(line)).toBeLessThan(width)
  })
})
