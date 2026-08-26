import { afterEach, describe, expect, test } from 'bun:test'
import { createCLIEventHandler } from '../../src/channels/cli-events'

const realWrite = process.stdout.write.bind(process.stdout)
let captured = ''

function capture(): void {
  captured = ''
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += String(chunk)
    return true
  }) as typeof process.stdout.write
}

afterEach(() => {
  process.stdout.write = realWrite
})

describe('CLI turn summary line', () => {
  test('tools ran → one dim ledger line with verb tallies and failures', () => {
    capture()
    const { handler } = createCLIEventHandler(false)
    handler.onToolCallStart?.([
      { id: 'a', name: 'execute_command', arguments: { command: 'ls' } },
      { id: 'b', name: 'write_file', arguments: { path: 'x', content: 'y' } },
    ])
    handler.onToolCallComplete?.('a', 'execute_command', { success: true, output: 'ok' })
    handler.onToolCallComplete?.('b', 'write_file', { success: false, output: 'denied' })
    handler.onResponseComplete?.()
    expect(captured).toContain('⋯')
    expect(captured).toContain('ran 1 command')
    expect(captured).toContain('edited 1 file')
    expect(captured).toContain('1 failed')
  })

  test('a toolless turn prints no summary', () => {
    capture()
    const { handler } = createCLIEventHandler(false)
    handler.onResponseComplete?.()
    expect(captured).not.toContain('⋯')
  })

  test('summary resets between turns', () => {
    capture()
    const { handler } = createCLIEventHandler(false)
    handler.onToolCallStart?.([{ id: 'a', name: 'execute_command', arguments: {} }])
    handler.onToolCallComplete?.('a', 'execute_command', { success: true, output: 'ok' })
    handler.onResponseComplete?.()
    captured = ''
    handler.onResponseComplete?.()
    expect(captured).not.toContain('⋯')
  })
})
