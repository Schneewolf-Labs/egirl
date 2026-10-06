/**
 * An ACP agent that hangs like acp-hang-agent.ts, but first starts a grandchild that escapes the
 * agent's process tree while keeping the agent's stdout open. Killing the agent then leaves the
 * stdout pipe held for ~8s, which is what a backend waiting on the pipe closing would sit through.
 * Writes the grandchild's pid to argv[2] so the test can clean it up.
 */
import * as acp from '@agentclientprotocol/sdk'
import { spawn } from 'child_process'
import { writeFileSync } from 'fs'
import { Readable, Writable } from 'stream'

const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], {
  // Its own session on POSIX, so a process-group kill of the agent misses it.
  detached: true,
  stdio: ['ignore', 'inherit', 'ignore'],
  windowsHide: true,
})
grandchild.unref()
const pidFile = process.argv[2]
if (pidFile && grandchild.pid) writeFileSync(pidFile, String(grandchild.pid))

acp
  .agent({ name: 'hang-escaped' })
  .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION }))
  .onRequest('session/new', () => ({ sessionId: 'hang-2' }))
  .onRequest('session/prompt', () => new Promise<acp.PromptResponse>(() => {}))
  .onNotification('session/cancel', () => {})
  .connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
    ),
  )
