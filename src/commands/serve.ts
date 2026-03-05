import { type AgentFactory, createAgentLoop } from '../agent'
import { SessionMutex } from '../agent/session-mutex'
import { createAPIServer } from '../api'
import { createAppServices } from '../bootstrap'
import { createDiscordChannel, createXMPPChannel } from '../channels'
import type { RuntimeConfig } from '../config'
import { gatherStandup } from '../standup'
import { createDiscovery, createTaskRunner, seedHeartbeatTask } from '../tasks'
import { createTaskTools } from '../tools/builtin/tasks'
import { applyLogLevel } from '../util/args'
import { log } from '../util/logger'

export async function runServe(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)

  const discordConf = config.channels.discord
  const apiConf = config.channels.api
  const xmppConf = config.channels.xmpp

  if (!discordConf && !apiConf && !xmppConf) {
    console.error(
      'Error: No channels configured. Configure at least one of: channels.discord, channels.api, channels.xmpp in egirl.toml',
    )
    process.exit(1)
  }

  const {
    providers,
    memory,
    conversations,
    taskStore,
    router,
    toolExecutor,
    stats,
    transcript,
    skills,
    browser,
  } = await createAppServices(config)

  const standup = await gatherStandup(config.workspace.path)
  const sessionMutex = new SessionMutex()

  const activeChannels: string[] = []
  const shutdownFns: Array<() => Promise<void>> = []

  // --- Discord ---
  let discord: ReturnType<typeof createDiscordChannel> | undefined
  let taskRunner: ReturnType<typeof createTaskRunner> | undefined
  let discovery: ReturnType<typeof createDiscovery> | undefined

  if (discordConf) {
    const agentFactory: AgentFactory = (sessionId: string) =>
      createAgentLoop({
        config,
        router,
        toolExecutor,
        localProvider: providers.local,
        remoteProvider: providers.remote,
        providers,
        sessionId,
        memory,
        conversationStore: conversations,
        transcript,
        skills,
        additionalContext: standup.context || undefined,
        sessionMutex,
      })

    discord = createDiscordChannel(agentFactory, discordConf, providers.local)
    activeChannels.push('discord')

    if (taskStore && config.tasks.enabled && config.tools.tasks) {
      const outbound = new Map<string, { send(target: string, message: string): Promise<void> }>()
      outbound.set('discord', discord)

      taskRunner = createTaskRunner({
        config,
        tasksConfig: config.tasks,
        store: taskStore,
        toolExecutor,
        router,
        localProvider: providers.local,
        remoteProvider: providers.remote,
        memory,
        transcript,
        outbound,
        conversationStore: conversations,
        sessionMutex,
      })

      const defaultTarget = config.channels.discord?.allowedChannels[0] ?? 'dm'
      const taskTools = createTaskTools(taskStore, taskRunner, config.tasks.maxActiveTasks, () => ({
        channel: 'discord',
        channelTarget: defaultTarget,
      }))
      toolExecutor.registerAll([
        taskTools.taskAddTool,
        taskTools.taskProposeTool,
        taskTools.taskListTool,
        taskTools.taskPauseTool,
        taskTools.taskResumeTool,
        taskTools.taskCancelTool,
        taskTools.taskRunNowTool,
        taskTools.taskHistoryTool,
      ])

      discord.onReaction(async (event) => {
        if (event.isBot) return
        const proposal = taskStore.getProposalByMessage(event.messageId)
        if (!proposal) return

        if (event.emoji === '✅') {
          taskStore.update(proposal.taskId, { status: 'active' as const })
          taskStore.updateProposal(proposal.id, { status: 'approved' })
          taskRunner?.activateTask(proposal.taskId)
          log.info('tasks', `Task ${proposal.taskId} approved via reaction`)
        }
        if (event.emoji === '❌') {
          taskStore.updateProposal(proposal.id, { status: 'rejected', rejectedAt: Date.now() })
          taskStore.delete(proposal.taskId)
          log.info('tasks', `Task ${proposal.taskId} rejected via reaction`)
        }
      })

      if (config.tasks.discoveryEnabled) {
        discovery = createDiscovery({
          config,
          tasksConfig: config.tasks,
          store: taskStore,
          runner: taskRunner,
          toolExecutor,
          router,
          localProvider: providers.local,
          memory,
          transcript,
        })
      }

      seedHeartbeatTask({
        store: taskStore,
        runner: taskRunner,
        tasksConfig: config.tasks,
        heartbeatConfig: config.tasks.heartbeat,
        workspacePath: config.workspace.path,
        channel: 'discord',
        channelTarget: defaultTarget,
      })

      log.info('main', 'Background task system initialized')
    }

    shutdownFns.push(async () => discord?.stop())
  }

  // --- API ---
  let api: ReturnType<typeof createAPIServer> | undefined

  if (apiConf) {
    const agent = createAgentLoop({
      config,
      router,
      toolExecutor,
      localProvider: providers.local,
      remoteProvider: providers.remote,
      providers,
      sessionId: 'api:default',
      memory,
      conversationStore: conversations,
      transcript,
      skills,
      additionalContext: standup.context || undefined,
      sessionMutex,
    })

    api = createAPIServer(
      {
        port: apiConf.port,
        host: apiConf.host,
        bearerToken: apiConf.apiKey,
        rateLimitPerMinute: apiConf.rateLimit,
        maxRequestBytes: apiConf.maxRequestBytes,
        corsOrigins: apiConf.corsOrigins,
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

    activeChannels.push('api')
    shutdownFns.push(async () => {
      api?.stop()
    })
  }

  // --- XMPP ---
  let xmpp: ReturnType<typeof createXMPPChannel> | undefined

  if (xmppConf) {
    const agent = createAgentLoop({
      config,
      router,
      toolExecutor,
      localProvider: providers.local,
      remoteProvider: providers.remote,
      providers,
      sessionId: 'xmpp:default',
      memory,
      conversationStore: conversations,
      transcript,
      skills,
      additionalContext: standup.context || undefined,
      sessionMutex,
    })

    xmpp = createXMPPChannel(agent, xmppConf)
    activeChannels.push('xmpp')
    shutdownFns.push(async () => xmpp?.stop())
  }

  // --- Graceful shutdown ---
  const shutdown = async () => {
    log.info('main', 'Shutting down...')
    discovery?.stop()
    taskRunner?.stop()
    for (const fn of shutdownFns) {
      await fn().catch(() => {})
    }
    taskStore?.close()
    conversations?.close()
    await browser.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // --- Start channels ---
  if (discord) {
    await discord.start()
    taskRunner?.start()
    discovery?.start()
  }

  if (api) {
    api.start()
  }

  if (xmpp) {
    await xmpp.start()
  }

  log.info('main', `Serving channels: ${activeChannels.join(', ')}`)
}
