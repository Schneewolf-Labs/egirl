import type { RuntimeConfig } from '../config'
import { createAgentLoop } from '../agent'
import { createXMPPChannel } from '../channels'
import { createAppServices } from '../bootstrap'
import { applyLogLevel } from '../util/args'
import { log } from '../util/logger'

export async function runXMPP(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)

  if (!config.channels.xmpp) {
    console.error('Error: XMPP not configured. Add XMPP_USERNAME and XMPP_PASSWORD to .env and configure channels.xmpp in egirl.toml')
    process.exit(1)
  }

  const { providers, router, toolExecutor, skills } = await createAppServices(config)

  const agent = createAgentLoop({
    config,
    router,
    toolExecutor,
    localProvider: providers.local,
    remoteProvider: providers.remote,
    sessionId: 'xmpp:default',
    skills,
  })

  const xmpp = createXMPPChannel(agent, config.channels.xmpp)

  const shutdown = async () => {
    log.info('main', 'Shutting down...')
    await xmpp.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await xmpp.start()

  log.info('main', 'XMPP bot running. Press Ctrl+C to stop.')
}
