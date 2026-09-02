import { createAgentLoop } from '../agent'
import { SessionMutex } from '../agent/session-mutex'
import { createAppServices } from '../bootstrap'
import { createTelegramChannel } from '../channels'
import type { RuntimeConfig } from '../config'
import { gatherStandup } from '../standup'
import { applyLogLevel } from '../util/args'
import { log } from '../util/logger'

export async function runTelegram(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)

  if (!config.channels.telegram) {
    console.error(
      'Error: Telegram not configured. Add TELEGRAM_BOT_TOKEN to .env and configure channels.telegram in egirl.toml',
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
    sessionId: 'telegram:default',
    memory,
    conversationStore: conversations,
    transcript,
    skills,
    additionalContext: standup.context || undefined,
    sessionMutex,
  })

  const telegram = createTelegramChannel(agent, config.channels.telegram)

  const shutdown = async () => {
    log.info('main', 'Shutting down...')
    await telegram.stop()
    await processRegistry.shutdownAll()
    conversations?.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await telegram.start()

  log.info('main', 'Telegram bot running. Press Ctrl+C to stop.')
}
