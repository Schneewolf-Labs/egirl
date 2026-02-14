import type { RuntimeConfig } from '../config'
import { createAgentLoop } from '../agent'
import { createAPIServer } from '../api'
import { createAppServices } from '../bootstrap'
import { applyLogLevel } from '../util/args'
import { log } from '../util/logger'
import { gatherStandup } from '../standup'

export async function runAPI(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)

  // Port/host from args override config
  const portIndex = args.indexOf('--port')
  const hostIndex = args.indexOf('--host')
  const port = portIndex !== -1 ? parseInt(args[portIndex + 1]!, 10) : (config.channels.api?.port ?? 3000)
  const host = hostIndex !== -1 ? args[hostIndex + 1]! : (config.channels.api?.host ?? '127.0.0.1')

  const { providers, memory, router, toolExecutor, stats, skills, browser } = await createAppServices(config)

  // Gather workspace standup for agent context
  const standup = await gatherStandup(config.workspace.path)

  const agent = createAgentLoop({
    config,
    router,
    toolExecutor,
    localProvider: providers.local,
    remoteProvider: providers.remote,
    sessionId: 'api:default',
    skills,
    additionalContext: standup.context || undefined,
  })

  const api = createAPIServer({ port, host }, {
    config,
    agent,
    toolExecutor,
    memory,
    providers,
    stats,
    browser,
  })

  const shutdown = async () => {
    log.info('main', 'Shutting down...')
    api.stop()
    await browser.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  api.start()
}
