/**
 * An ACP agent that accepts a session and then never finishes a prompt, ignoring session/cancel.
 * Spawned by the acp backend's timeout test to prove the process is killed, not waited on.
 */
import * as acp from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'stream'

acp
  .agent({ name: 'hang' })
  .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION }))
  .onRequest('session/new', () => ({ sessionId: 'hang-1' }))
  .onRequest('session/prompt', () => new Promise<acp.PromptResponse>(() => {}))
  .onNotification('session/cancel', () => {})
  .connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
    ),
  )
