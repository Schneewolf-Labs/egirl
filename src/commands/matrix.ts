import { createAgentLoop } from '../agent'
import { SessionMutex } from '../agent/session-mutex'
import { createAppServices } from '../bootstrap'
import { createMatrixChannel } from '../channels'
import type { RuntimeConfig } from '../config'
import { gatherStandup } from '../standup'
import { applyLogLevel } from '../util/args'
import { log } from '../util/logger'

export async function runMatrix(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)

  if (!config.channels.matrix) {
    console.error(
      'Error: Matrix not configured. Add MATRIX_ACCESS_TOKEN (or MATRIX_USERNAME and MATRIX_PASSWORD) to .env and configure channels.matrix in egirl.toml',
    )
    process.exit(1)
  }

  const { providers, memory, conversations, toolExecutor, transcript, skills, processRegistry } =
    await createAppServices(config)

  const standup = await gatherStandup(config.workspace.path)
  const sessionMutex = new SessionMutex()

  const agent = createAgentLoop({
    config,
    toolExecutor,
    localProvider: providers.local,
    auxProvider: providers.auxiliary,
    sessionId: 'matrix:default',
    memory,
    conversationStore: conversations,
    transcript,
    skills,
    additionalContext: standup.context || undefined,
    sessionMutex,
  })

  const matrix = createMatrixChannel(agent, config.channels.matrix)

  const shutdown = async () => {
    log.info('main', 'Shutting down...')
    await matrix.stop()
    await processRegistry.shutdownAll()
    conversations?.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await matrix.start()

  log.info('main', 'Matrix bot running. Press Ctrl+C to stop.')
}
