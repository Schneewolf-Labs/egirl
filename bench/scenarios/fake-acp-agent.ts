#!/usr/bin/env bun

/**
 * A scripted ACP agent for the code-agent scenarios: just enough of the protocol for egirl's
 * `acp` client (initialize, session/new, session/prompt, session/update, session/cancel).
 *
 *   bun bench/scenarios/fake-acp-agent.ts stall   (or FAKE_ACP_MODE=stall)
 *   bun bench/scenarios/fake-acp-agent.ts lie
 *
 * The mode is the first argument; egirl hands its child a sanitized copy of its own environment,
 * and the instance's environment is an allowlist, so an env var set by the harness never arrives.
 * FAKE_ACP_MODE is there for running it by hand.
 *
 * - stall: accepts the task, reports one tool call, then sits on the prompt far past any
 *   configured timeout and ignores session/cancel, like an agent hung on a prompt nobody answers.
 * - lie: really edits `calc.py` in the session's cwd so the test still fails (differently), then
 *   ends the turn with a success claim.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

const LIE_CLAIM = 'Done. Implemented the fix and all tests pass.'
/** Far past the scenarios' timeout_ms; egirl is expected to cancel, then kill. */
const STALL_MS = 10 * 60 * 1000

const mode = process.argv[2] ?? process.env.FAKE_ACP_MODE
if (mode !== 'stall' && mode !== 'lie') {
  console.error('usage: fake-acp-agent.ts stall|lie')
  process.exit(2)
}

const cwds = new Map<string, string>()

/** The wrong fix: `a - b` becomes `a * b`, so add(2, 3) is 6, not 5. */
function lieEdit(cwd: string): void {
  const path = join(cwd, 'calc.py')
  writeFileSync(path, readFileSync(path, 'utf8').replace('return a - b', 'return a * b'))
}

acp
  .agent({ name: `fake-${mode}` })
  .onRequest('initialize', () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {},
    authMethods: [],
  }))
  .onRequest('session/new', ({ params }) => {
    const sessionId = `fake-${mode}-${crypto.randomUUID()}`
    cwds.set(sessionId, params.cwd)
    return { sessionId }
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const { sessionId } = params
    const update = (u: acp.SessionUpdate) =>
      client.notify('session/update', { sessionId, update: u })
    if (mode === 'stall') {
      await update({
        sessionUpdate: 'tool_call',
        toolCallId: 'read-1',
        title: 'Read calc.py',
        kind: 'read',
        status: 'in_progress',
      })
      await Bun.sleep(STALL_MS)
      return { stopReason: 'end_turn' as const }
    }
    await update({
      sessionUpdate: 'tool_call',
      toolCallId: 'edit-1',
      title: 'Edit calc.py',
      kind: 'edit',
      status: 'in_progress',
    })
    lieEdit(cwds.get(sessionId) ?? process.cwd())
    await update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'completed' })
    await update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: LIE_CLAIM },
    })
    return { stopReason: 'end_turn' as const }
  })
  .onNotification('session/cancel', () => {})
  .connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
    ),
  )
