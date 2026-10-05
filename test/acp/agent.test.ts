/**
 * egirl as an ACP agent, and the round trip: egirl's own `acp` code-agent backend driving
 * egirl's ACP agent, with a stub model behind the loop. No processes, no network.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import * as acp from '@agentclientprotocol/sdk'
import { join } from 'path'
import { createAcpAgent, promptToRun } from '../../src/acp/agent'
import { AgentLoop } from '../../src/agent/loop'
import { resetSessionEvents } from '../../src/agent/session-events'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { runAcpSession } from '../../src/tools/builtin/code-agent/acp'
import { makeConfig, makeExecutorWithNoop, makeWorkspace, stubResponse } from '../agent/helpers'
import { inProcess } from './helpers'

/** A model that calls the noop tool once, then streams its answer token by token. */
function scriptedProvider(seen: string[]): LLMProvider {
  let n = 0
  return {
    name: 'stub',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      n++
      const last = req.messages[req.messages.length - 1]
      if (typeof last?.content === 'string') seen.push(last.content)
      if (n === 1) {
        return stubResponse({
          tool_calls: [{ id: 'call-1', name: 'noop', arguments: { why: 'look around' } }],
          finish_reason: 'tool_calls',
        })
      }
      for (const token of ['Fixed ', 'the ', 'tests.']) req.onToken?.(token)
      return stubResponse({ content: 'Fixed the tests.' })
    },
  }
}

function egirlAgent(provider: LLMProvider, cwds: string[] = []): acp.AgentApp {
  const workspace = makeWorkspace()
  return createAcpAgent((sessionId, cwd) => {
    cwds.push(cwd)
    return new AgentLoop({
      config: makeConfig(workspace),
      toolExecutor: makeExecutorWithNoop(),
      localProvider: provider,
      sessionId,
    })
  })
}

describe('egirl as an ACP agent', () => {
  afterEach(() => resetSessionEvents())

  test('round trip: the acp backend drives egirl over ACP and gets the streamed answer', async () => {
    const seen: string[] = []
    const cwds: string[] = []
    const fake = inProcess(() => egirlAgent(scriptedProvider(seen), cwds))
    const workingDir = join(makeWorkspace(), 'project')

    const result = await runAcpSession(
      {
        permissionMode: 'bypassPermissions',
        workingDir,
        acpCommand: ['egirl', 'acp'],
        timeoutMs: 5000,
      },
      'Fix the failing test',
      workingDir,
      [],
      fake.connect,
    )

    expect(result.success).toBe(true)
    expect(result.output).toStartWith('Fixed the tests.')
    expect(result.output).toContain('[code_agent: acp egirl acp | 1 tool calls |')
    expect(seen[0]).toBe('Fix the failing test')
    expect(cwds).toEqual([workingDir])
    expect(fake.spawned).toEqual([{ command: ['egirl', 'acp'], cwd: workingDir }])
    expect(fake.closes).toEqual([false])
  })

  test('streams message chunks and tool calls as session/update, then ends the turn', async () => {
    const updates: acp.SessionUpdate[] = []
    const app = acp.client({ name: 'test' }).onNotification('session/update', ({ params }) => {
      updates.push(params.update)
    })

    const { init, sessionId, stop } = await app.connectWith(
      egirlAgent(scriptedProvider([])),
      async (cx) => {
        const init = await cx.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION })
        const { sessionId } = await cx.request('session/new', {
          cwd: makeWorkspace(),
          mcpServers: [],
        })
        const stop = await cx.request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: 'go' }],
        })
        return { init, sessionId, stop }
      },
    )

    expect(init.agentInfo?.name).toBe('egirl')
    expect(init.agentCapabilities?.loadSession).toBe(false)
    expect(sessionId).toStartWith('acp:')
    expect(stop.stopReason).toBe('end_turn')
    const kinds = updates.map((u) => u.sessionUpdate)
    expect(kinds).toEqual([
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
      'agent_message_chunk',
      'agent_message_chunk',
    ])
    const call = updates[0]
    if (call?.sessionUpdate !== 'tool_call') throw new Error('expected tool_call')
    expect(call).toMatchObject({ toolCallId: 'call-1', title: 'noop', status: 'in_progress' })
    expect(updates[1]).toMatchObject({ toolCallId: 'call-1', status: 'completed' })
  })

  test('session/cancel aborts the run and the prompt stops as cancelled', async () => {
    // A model that never answers until its request is aborted.
    const provider: LLMProvider = {
      name: 'stub',
      chat: (req: ChatRequest) =>
        new Promise<ChatResponse>((_resolve, reject) => {
          req.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    }
    const stop = await acp.client().connectWith(egirlAgent(provider), async (cx) => {
      await cx.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION })
      const { sessionId } = await cx.request('session/new', {
        cwd: makeWorkspace(),
        mcpServers: [],
      })
      const prompt = cx.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'take forever' }],
      })
      await Bun.sleep(20)
      await cx.notify('session/cancel', { sessionId })
      return prompt
    })
    expect(stop.stopReason).toBe('cancelled')
  })

  test('unsupported and invalid requests are JSON-RPC errors, not crashes', async () => {
    const codes = await acp.client().connectWith(egirlAgent(scriptedProvider([])), async (cx) => {
      const code = (p: Promise<unknown>) =>
        p.then(
          () => 0,
          (error: { code?: number }) => error.code,
        )
      await cx.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION })
      return {
        load: await code(
          cx.request('session/load', { sessionId: 'x', cwd: makeWorkspace(), mcpServers: [] }),
        ),
        relative: await code(cx.request('session/new', { cwd: 'relative/dir', mcpServers: [] })),
        unknown: await code(
          cx.request('session/prompt', {
            sessionId: 'acp:nope',
            prompt: [{ type: 'text', text: 'hi' }],
          }),
        ),
        // Still alive afterwards.
        alive: (await cx.request('session/new', { cwd: makeWorkspace(), mcpServers: [] }))
          .sessionId,
      }
    })
    expect(codes.load).toBe(-32601)
    expect(codes.relative).toBe(-32602)
    expect(codes.unknown).toBe(-32602)
    expect(codes.alive).toStartWith('acp:')
  })

  test('prompt blocks flatten to text and data: URL images', () => {
    const run = promptToRun([
      { type: 'text', text: 'Look at this' },
      { type: 'resource_link', uri: 'file:///repo/a.ts', name: 'a.ts' },
      { type: 'resource', resource: { uri: 'file:///repo/b.ts', text: 'const b = 1' } },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    ])
    expect(run.text).toContain('Look at this')
    expect(run.text).toContain('[Referenced file: file:///repo/a.ts]')
    expect(run.text).toContain('const b = 1')
    expect(run.images).toEqual(['data:image/png;base64,AAAA'])
  })
})
