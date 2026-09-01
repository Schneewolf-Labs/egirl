import { createAgentLoop } from '../agent'
import { SessionMutex } from '../agent/session-mutex'
import { createAppServices } from '../bootstrap'
import { createXMPPChannel } from '../channels'
import type { RuntimeConfig } from '../config'
import { gatherStandup } from '../standup'
import { applyLogLevel } from '../util/args'
import { log } from '../util/logger'

export async function runXMPP(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)

  if (!config.channels.xmpp) {
    console.error(
      'Error: XMPP not configured. Add XMPP_USERNAME and XMPP_PASSWORD to .env and configure channels.xmpp in egirl.toml',
    )
    process.exit(1)
  }

  const {
    providers,
    memory,
    conversations,
    toolExecutor,
    transcript,
    skills,
    processRegistry,
    delegationRegistry,
  } = await createAppServices(config)

  const standup = await gatherStandup(config.workspace.path)
  const sessionMutex = new SessionMutex()

  const agent = createAgentLoop({
    config,
    toolExecutor,
    localProvider: providers.local,
    auxProvider: providers.auxiliary,
    sessionId: 'xmpp:default',
    memory,
    conversationStore: conversations,
    transcript,
    skills,
    additionalContext: standup.context || undefined,
    sessionMutex,
    delegations: delegationRegistry,
  })

  const xmpp = createXMPPChannel(agent, config.channels.xmpp)

  const shutdown = async () => {
    log.info('main', 'Shutting down...')
    await xmpp.stop()
    delegationRegistry.stopAll()
    await processRegistry.shutdownAll()
    conversations?.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await xmpp.start()

  log.info('main', 'XMPP bot running. Press Ctrl+C to stop.')
}
