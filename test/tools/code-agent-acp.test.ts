import { describe, expect, test } from 'bun:test'
import * as acp from '@agentclientprotocol/sdk'
import { tmpdir } from 'os'
import { join } from 'path'
import { PermissionSupervisor } from '../../src/permissions/supervisor'
import { runAcpSession } from '../../src/tools/builtin/code-agent/acp'
import { shouldFailover } from '../../src/tools/builtin/code-agent/failover'
import type { CodeAgentConfig } from '../../src/tools/builtin/code-agent/types'
import { inProcess } from '../acp/helpers'

function supervisor(
  action: 'allow' | 'deny' | 'ask_user',
  mode: 'rules_only' | 'bypass' = 'rules_only',
): PermissionSupervisor {
  return new PermissionSupervisor({
    config: {
      mode,
      defaultAction: action,
      thinkBeforeDeciding: false,
      minConfidence: 0,
      askUserBelowConfidence: false,
      memoryRecall: false,
      memoryWrite: false,
      policy: { allow: [], deny: [], askUser: [] },
    },
  })
}

const OPTIONS: acp.PermissionOption[] = [
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
]

/**
 * A fake ACP agent that asks permission for one tool call, then reports the outcome it got as
 * its answer. Records whether the turn was cancelled.
 */
function askingAgent(kind: acp.ToolKind, seen: { cancelled: boolean }): () => acp.AgentApp {
  return () =>
    acp
      .agent({ name: 'asker' })
      .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION }))
      .onRequest('session/new', () => ({ sessionId: 's1' }))
      .onRequest('session/prompt', async ({ params, client }) => {
        const { outcome } = await client.request('session/request_permission', {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 't1', title: 'rm -rf build', kind, rawInput: { cmd: 'x' } },
          options: OPTIONS,
        })
        if (seen.cancelled) return { stopReason: 'cancelled' }
        const answer = outcome.outcome === 'selected' ? outcome.optionId : 'cancelled'
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } },
        })
        return { stopReason: 'end_turn' }
      })
      .onNotification('session/cancel', () => {
        seen.cancelled = true
      })
}

async function run(
  config: Partial<CodeAgentConfig>,
  kind: acp.ToolKind = 'execute',
): Promise<{ output: string; success: boolean; cancelled: boolean }> {
  const seen = { cancelled: false }
  const fake = inProcess(askingAgent(kind, seen))
  const result = await runAcpSession(
    {
      permissionMode: 'default',
      workingDir: tmpdir(),
      acpCommand: ['fake-agent'],
      timeoutMs: 5000,
      ...config,
    },
    'Clean the build',
    tmpdir(),
    [],
    fake.connect,
  )
  return { ...result, cancelled: seen.cancelled }
}

describe('acp code agent: permission requests', () => {
  test('a supervisor allow grants once, never "always"', async () => {
    const result = await run({ permissionSupervisor: supervisor('allow') })
    expect(result.success).toBe(true)
    expect(result.output).toStartWith('once')
  })

  test('a supervisor deny rejects and the agent carries on', async () => {
    const result = await run({ permissionSupervisor: supervisor('deny') })
    expect(result.success).toBe(true)
    expect(result.output).toStartWith('no')
  })

  test('ask_user cancels the turn and reports that approval is needed', async () => {
    const result = await run({ permissionSupervisor: supervisor('ask_user') })
    expect(result.success).toBe(false)
    expect(result.cancelled).toBe(true)
    expect(result.output).toContain('needs user approval')
  })

  test('without an active supervisor, permission_mode decides', async () => {
    const inactive = supervisor('deny', 'bypass')
    expect(
      (await run({ permissionMode: 'bypassPermissions', permissionSupervisor: inactive })).output,
    ).toStartWith('once')
    expect((await run({ permissionMode: 'default' })).output).toStartWith('no')
    expect((await run({ permissionMode: 'plan' }, 'read')).output).toStartWith('once')
    expect((await run({ permissionMode: 'acceptEdits' }, 'edit')).output).toStartWith('once')
    expect((await run({ permissionMode: 'acceptEdits' }, 'execute')).output).toStartWith('no')
  })
})

describe('acp code agent: failures', () => {
  test('a timeout cancels the turn, closes the agent, and is reported as a timeout', async () => {
    const seen = { cancelled: false }
    const fake = inProcess(() =>
      acp
        .agent()
        .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION }))
        .onRequest('session/new', () => ({ sessionId: 's1' }))
        .onRequest('session/prompt', async ({ params, client }) => {
          await client.notify('session/update', {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'halfway there' },
            },
          })
          // Never answers; honours cancel the way the protocol asks.
          return new Promise<acp.PromptResponse>((resolve) => {
            const timer = setInterval(() => {
              if (seen.cancelled) {
                clearInterval(timer)
                resolve({ stopReason: 'cancelled' })
              }
            }, 5)
          })
        })
        .onNotification('session/cancel', () => {
          seen.cancelled = true
        }),
    )
    const result = await runAcpSession(
      { permissionMode: 'default', workingDir: tmpdir(), acpCommand: ['x'], timeoutMs: 100 },
      'Long task',
      tmpdir(),
      [],
      fake.connect,
    )
    expect(result.success).toBe(false)
    expect(result.output).toContain('timed out after')
    expect(result.output).toContain('halfway there')
    expect(seen.cancelled).toBe(true)
    expect(fake.closes).toEqual([false])
  })

  test('a spawned agent that ignores cancel is killed at the deadline', async () => {
    const started = Date.now()
    const result = await runAcpSession(
      {
        permissionMode: 'default',
        workingDir: tmpdir(),
        acpCommand: [
          process.execPath,
          join(import.meta.dir, '..', 'fixtures', 'acp-hang-agent.ts'),
        ],
        timeoutMs: 1000,
      },
      'Hang',
      tmpdir(),
    )
    expect(result.success).toBe(false)
    expect(result.output).toContain('timed out after 1s')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test('an agent binary that does not exist fails over', async () => {
    const result = await runAcpSession(
      {
        permissionMode: 'default',
        workingDir: tmpdir(),
        acpCommand: ['egirl-no-such-acp-agent'],
        timeoutMs: 10_000,
      },
      't',
      tmpdir(),
    )
    expect(result.success).toBe(false)
    expect(shouldFailover(result)).toBe(true)
  })

  test('no acp_command is a start failure, eligible for failover', async () => {
    const result = await runAcpSession(
      { permissionMode: 'default', workingDir: tmpdir() },
      't',
      tmpdir(),
    )
    expect(result.success).toBe(false)
    expect(result.output).toContain('failed to start')
    expect(shouldFailover(result)).toBe(true)
  })

  test('an agent that ends the turn with no text produced no output', async () => {
    const fake = inProcess(() =>
      acp
        .agent()
        .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION }))
        .onRequest('session/new', () => ({ sessionId: 's1' }))
        .onRequest('session/prompt', () => ({ stopReason: 'end_turn' })),
    )
    const result = await runAcpSession(
      { permissionMode: 'default', workingDir: tmpdir(), acpCommand: ['x'] },
      't',
      tmpdir(),
      [],
      fake.connect,
    )
    expect(result.success).toBe(false)
    expect(result.output).toContain('produced no output')
  })
})
