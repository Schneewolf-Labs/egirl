import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { runClaudeSession } from '../../src/tools/builtin/code-agent/claude'
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  deadlineLimits,
  startDeadline,
} from '../../src/tools/builtin/code-agent/deadline'
import { TIMEOUT_PREFIX } from '../../src/tools/builtin/code-agent/timeout-report'
import { ToolExecutor } from '../../src/tools/executor'
import type { Tool } from '../../src/tools/types'

/**
 * Observed: code_agent "timed out after 300s" over and over, on work that was going fine. The
 * cap is now generous, and an agent that has gone quiet is stopped on its own, shorter clock.
 */

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('startDeadline', () => {
  test('stops a run that has gone quiet before the total cap', async () => {
    let fired = 0
    const d = startDeadline({ totalMs: 1000, idleMs: 40 }, () => fired++)
    await wait(80)
    expect(d.expired).toBe('idle')
    expect(fired).toBe(1)
    d.clear()
  })

  test('activity keeps a working run alive until the total cap', async () => {
    const d = startDeadline({ totalMs: 150, idleMs: 50 }, () => {})
    const beat = setInterval(() => d.touch(), 20)
    await wait(200)
    clearInterval(beat)
    expect(d.expired).toBe('total')
    expect(d.elapsedMs).toBeGreaterThanOrEqual(140)
    d.clear()
  })

  test('idleMs 0 turns the stall check off', async () => {
    const d = startDeadline({ totalMs: 120, idleMs: 0 }, () => {})
    await wait(60)
    expect(d.expired).toBeUndefined()
    await wait(100)
    expect(d.expired).toBe('total')
  })

  test('defaults: 30 minutes in all, 10 minutes of silence', () => {
    expect(deadlineLimits({})).toEqual({
      totalMs: DEFAULT_TIMEOUT_MS,
      idleMs: DEFAULT_IDLE_TIMEOUT_MS,
    })
    expect(DEFAULT_TIMEOUT_MS).toBe(1_800_000)
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(600_000)
  })
})

type FakeQuery = Parameters<typeof runClaudeSession>[5]

/** One Bash call, then silence until aborted. */
function quietAfterOneCall(): FakeQuery {
  return (({ options }: { options: Options }) =>
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-1' } as unknown as SDKMessage
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bun test' } }],
        },
      } as unknown as SDKMessage
      await new Promise<void>((resolve) => {
        options.abortController?.signal.addEventListener('abort', () => resolve())
      })
      throw new Error('Claude Code process aborted by user')
    })()) as unknown as FakeQuery
}

describe('claude code agent', () => {
  test('a stalled run is stopped early and the report says it stalled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egirl-stall-'))
    const started = Date.now()
    const result = await runClaudeSession(
      {
        permissionMode: 'bypassPermissions',
        workingDir: dir,
        timeoutMs: 60_000,
        idleTimeoutMs: 50,
      },
      'run the tests',
      dir,
      [],
      {},
      quietAfterOneCall(),
    )
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result.success).toBe(false)
    expect(result.output.startsWith(TIMEOUT_PREFIX)).toBe(true)
    expect(result.output).toContain('stalled: nothing from the agent for 0s')
    expect(result.output).toContain('- Bash: bun test')
  })

  test('each action the agent takes is reported as it happens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egirl-progress-'))
    const progress: string[] = []
    await runClaudeSession(
      { permissionMode: 'bypassPermissions', workingDir: dir, timeoutMs: 100 },
      'run the tests',
      dir,
      [],
      { onProgress: (text) => progress.push(text) },
      quietAfterOneCall(),
    )
    expect(progress).toEqual(['Bash: bun test'])
  })
})

describe('executor', () => {
  test("a tool's progress reaches onToolProgress with its own call", async () => {
    const tool: Tool = {
      definition: {
        name: 'slow',
        description: 'd',
        parameters: { type: 'object', properties: {} },
      },
      async execute(_params, _cwd, ctx) {
        ctx?.onProgress?.('step one')
        return { success: true, output: 'ok' }
      },
    }
    const executor = new ToolExecutor()
    executor.register(tool)
    const heard: string[] = []
    await executor.execute({ id: 'c1', name: 'slow', arguments: {} }, tmpdir(), {
      onToolProgress: (call, text) => heard.push(`${call.id}:${call.name}:${text}`),
    })
    expect(heard).toEqual(['c1:slow:step one'])
  })
})
