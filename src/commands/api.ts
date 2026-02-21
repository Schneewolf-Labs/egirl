import { createAgentLoop } from '../agent'
import { SessionMutex } from '../agent/session-mutex'
import { createAPIServer } from '../api'
import { createAppServices } from '../bootstrap'
import type { RuntimeConfig } from '../config'
import { gatherStandup } from '../standup'
import { applyLogLevel } from '../util/args'
import { log } from '../util/logger'

export async function runAPI(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)

  // Port/host from args override config
  const portIndex = args.indexOf('--port')
  const hostIndex = args.indexOf('--host')
  const port =
    portIndex !== -1 ? parseInt(args[portIndex + 1] ?? '', 10) : (config.channels.api?.port ?? 3000)
  const host =
    hostIndex !== -1
      ? (args[hostIndex + 1] ?? '127.0.0.1')
      : (config.channels.api?.host ?? '127.0.0.1')

  const { providers, memory, router, toolExecutor, stats, transcript, skills, browser } =
    await createAppServices(config)

  // Gather workspace standup for agent context
  const standup = await gatherStandup(config.workspace.path)

  const sessionMutex = new SessionMutex(config.agentRunTimeoutMs)

  const agent = createAgentLoop({
    config,
    router,
    toolExecutor,
    localProvider: providers.local,
    remoteProvider: providers.remote,
    providers,
    sessionId: 'api:default',
    transcript,
    skills,
    additionalContext: standup.context || undefined,
    sessionMutex,
  })

  const apiConf = config.channels.api
  const api = createAPIServer(
    {
      port,
      host,
      bearerToken: apiConf?.apiKey,
      rateLimitPerMinute: apiConf?.rateLimit ?? 30,
      maxRequestBytes: apiConf?.maxRequestBytes ?? 65536,
      corsOrigins: apiConf?.corsOrigins ?? [],
    },
    {
      config,
      agent,
      toolExecutor,
      memory,
      providers,
      stats,
      browser,
    },
  )

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
