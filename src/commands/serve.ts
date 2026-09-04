import { type AgentFactory, createAgentLoop } from '../agent'
import { SessionMutex } from '../agent/session-mutex'
import { createAppServices } from '../bootstrap'
import {
  type ChatChannel,
  createDiscordChannel,
  createMatrixChannel,
  createTelegramChannel,
  createXMPPChannel,
} from '../channels'
import type { RuntimeConfig } from '../config'
import { createReplyBroker } from '../report/broker'
import { registerReportTool } from '../report/register'
import { gatherStandup } from '../standup'
import {
  createDiscovery,
  createTaskRunner,
  seedHeartbeatTask,
  taskRunnerEnabled,
  taskRunnerOffReason,
} from '../tasks'
import { createTaskTools } from '../tools/builtin/tasks'
import { applyLogLevel } from '../util/args'
import { log } from '../util/logger'

export async function runServe(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)

  const discordConf = config.channels.discord
  const xmppConf = config.channels.xmpp
  const telegramConf = config.channels.telegram
  const matrixConf = config.channels.matrix

  if (!discordConf && !xmppConf && !telegramConf && !matrixConf) {
    console.error(
      'Error: No channels configured. Configure channels.discord, channels.xmpp, channels.telegram or channels.matrix in egirl.toml to use serve mode, or run `bun run cli` instead.',
    )
    process.exit(1)
  }

  const { providers, memory, conversations, taskStore, toolExecutor, skills, processRegistry } =
    await createAppServices(config)

  const standup = await gatherStandup(config.workspace.path)
  const sessionMutex = new SessionMutex()

  const outbound = new Map<string, { send(target: string, message: string): Promise<void> }>()
  // Routes inbound chat messages to pending report asks (see src/report/broker.ts).
  const replyBroker = createReplyBroker()

  const agentFactory: AgentFactory = (sessionId: string) =>
    createAgentLoop({
      config,
      toolExecutor,
      localProvider: providers.local,
      auxProvider: providers.auxiliary,
      sessionId,
      memory,
      conversationStore: conversations,
      skills,
      additionalContext: standup.context || undefined,
      sessionMutex,
    })

  // Chat channels, in priority order: the first one configured is where background tasks
  // and the heartbeat report by default. Discord runs one session per channel/thread/DM;
  // the others are a single long-lived session -- the local model driving one chat stream.
  const chat: Array<{ channel: ChatChannel; defaultTarget: string }> = []
  let discord: ReturnType<typeof createDiscordChannel> | undefined
  if (discordConf) {
    discord = createDiscordChannel(agentFactory, discordConf, providers.local, replyBroker)
    chat.push({ channel: discord, defaultTarget: discordConf.allowedChannels[0] ?? 'dm' })
  }
  if (xmppConf) {
    chat.push({
      channel: createXMPPChannel(agentFactory('xmpp:default'), xmppConf, replyBroker),
      defaultTarget: xmppConf.allowedJids[0] ?? 'self',
    })
  }
  if (telegramConf) {
    chat.push({
      channel: createTelegramChannel(agentFactory('telegram:default'), telegramConf, replyBroker),
      defaultTarget: 'self',
    })
  }
  if (matrixConf) {
    chat.push({
      channel: createMatrixChannel(agentFactory('matrix:default'), matrixConf, replyBroker),
      defaultTarget: matrixConf.allowedRooms[0] ?? 'self',
    })
  }
  for (const { channel } of chat) outbound.set(channel.name, channel)

  // The agent's line to its supervisor — registered once channels exist so asks can block
  // on a human reply through the broker.
  registerReportTool(config, toolExecutor, outbound, replyBroker)

  // --- Background tasks (shared across channels) ---
  let taskRunner: ReturnType<typeof createTaskRunner> | undefined
  let discovery: ReturnType<typeof createDiscovery> | undefined

  if (taskRunnerEnabled(config, !!taskStore) && taskStore) {
    taskRunner = createTaskRunner({
      config,
      tasksConfig: config.tasks,
      store: taskStore,
      toolExecutor,
      localProvider: providers.local,
      auxProvider: providers.auxiliary,
      memory,
      outbound,
      conversationStore: conversations,
      sessionMutex,
    })

    const primary = chat[0]
    const defaultChannel = primary?.channel.name ?? 'discord'
    const defaultTarget = primary?.defaultTarget ?? 'self'

    const taskTools = createTaskTools(taskStore, taskRunner, config.tasks.maxActiveTasks, () => ({
      channel: defaultChannel,
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

    if (discord) {
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
    }

    if (config.tasks.discoveryEnabled) {
      discovery = createDiscovery({
        config,
        tasksConfig: config.tasks,
        store: taskStore,
        runner: taskRunner,
        toolExecutor,
        localProvider: providers.local,
        auxProvider: providers.auxiliary,
        memory,
      })
    }

    seedHeartbeatTask({
      store: taskStore,
      runner: taskRunner,
      tasksConfig: config.tasks,
      heartbeatConfig: config.tasks.heartbeat,
      workspacePath: config.workspace.path,
      channel: defaultChannel,
      channelTarget: defaultTarget,
    })

    log.info('main', 'Background task system initialized')
  } else {
    // Say WHY, naming the flag. A bare silence here means a populated [tasks] section that
    // simply never runs, which is exactly what happened in practice.
    const why = taskRunnerOffReason(config, !!taskStore)
    if (config.source.tasksConfiguredButGated) {
      log.warn('tasks', `[tasks] is configured but INERT: ${why}`)
    } else if (why) {
      log.info('tasks', `Background tasks off: ${why}`)
    }
  }

  const shutdown = async () => {
    log.info('main', 'Shutting down...')
    discovery?.stop()
    taskRunner?.stop()
    for (const { channel } of chat) {
      await channel.stop().catch(() => {})
    }
    await processRegistry.shutdownAll()
    taskStore?.close()
    conversations?.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // A chat channel that cannot connect leaves a degraded instance, not a dead one. Letting the
  // failure propagate meant one optional transport with a bad certificate took down the task
  // runner, peer discovery and every other channel with it -- an unattended agent should keep
  // doing the work it still can, and say which parts are missing.
  const started: string[] = []
  for (const { channel } of chat) {
    try {
      await channel.start()
      started.push(channel.name)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('main', `Channel "${channel.name}" failed to start: ${message}`)
      // Shut the client down rather than leaving it to reconnect. Some failures never resolve
      // on their own -- a self-signed certificate will be just as self-signed a second later --
      // and the client's own retry loop will otherwise log an error every second forever,
      // burying everything else the instance has to say.
      await channel.stop().catch(() => {})
      log.warn('main', `Continuing without ${channel.name}.`)
    }
  }
  taskRunner?.start()
  discovery?.start()

  if (!started.length) {
    log.warn('main', 'No channels started. Background tasks still run; chat is unavailable.')
  }
  log.info(
    'main',
    `Serving: ${started.join(' + ') || 'background tasks only'}. Press Ctrl+C to stop.`,
  )
}
