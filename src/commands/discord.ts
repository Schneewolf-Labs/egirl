import type { RuntimeConfig } from '../config'
import { createAgentLoop, type AgentFactory } from '../agent'
import { createDiscordChannel } from '../channels'
import { createAppServices } from '../bootstrap'
import { applyLogLevel } from '../util/args'
import { log } from '../util/logger'

export async function runDiscord(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)

  if (!config.channels.discord) {
    console.error('Error: Discord not configured. Add DISCORD_TOKEN to .env and configure channels.discord in egirl.toml')
    process.exit(1)
  }

  const { providers, memory, conversations, router, toolExecutor, skills } = await createAppServices(config)

  // Create agent factory for per-session loops
  const agentFactory: AgentFactory = (sessionId: string) => createAgentLoop({
    config,
    router,
    toolExecutor,
    localProvider: providers.local,
    remoteProvider: providers.remote,
    sessionId,
    memory,
    conversationStore: conversations,
    skills,
  })

  const discord = createDiscordChannel(agentFactory, config.channels.discord, providers.local)

  // Handle graceful shutdown
  const shutdown = async () => {
    log.info('main', 'Shutting down...')
    await discord.stop()
    conversations?.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await discord.start()

  log.info('main', 'Discord bot running. Press Ctrl+C to stop.')
}
