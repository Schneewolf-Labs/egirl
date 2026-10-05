import { Readable, Writable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import { createAcpAgent } from '../acp/agent'
import { createAgentLoop } from '../agent'
import type { RuntimeConfig } from '../config'
import { applyLogLevel } from '../util/args'
import { log } from '../util/logger'
import { createCommandRuntime } from './runtime'

/**
 * `egirl acp`: serve the Agent Client Protocol on stdio, so an editor can run egirl as its agent.
 * stdout is the protocol. Everything else -- logs, stray console output -- goes to stderr.
 */
export async function runAcp(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)
  // The logger already writes to stderr; this catches anything that prints directly, which
  // would otherwise land in the middle of a JSON-RPC frame and break the editor's connection.
  console.log = console.error
  console.info = console.error

  const rt = await createCommandRuntime(config)

  // A loop per ACP session. The editor's project directory is not the persona workspace (which
  // holds identity and memory files), so it is not made the tools' cwd. The agent is told where
  // the project is and passes it on: absolute paths to its file tools, working_dir to code_agent.
  const createLoop = (sessionId: string, cwd: string) =>
    createAgentLoop({
      config,
      toolExecutor: rt.toolExecutor,
      localProvider: rt.providers.local,
      auxProvider: rt.providers.auxiliary,
      sessionId,
      memory: rt.memory,
      conversationStore: rt.conversations,
      skills: rt.skills,
      additionalContext:
        `You are running inside the user's editor over ACP. The project they have open is ` +
        `\`${cwd}\`. Use absolute paths under it for file work, and pass it as working_dir ` +
        `when you delegate to the code agent.`,
      sessionMutex: rt.sessionMutex,
    })

  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  )
  const connection = createAcpAgent(createLoop).connect(stream)
  log.info('acp', 'Serving ACP on stdio')

  await connection.closed
  log.info('acp', 'Client disconnected')
  await rt.processRegistry.shutdownAll()
  rt.conversations?.close()
  process.exit(0)
}
