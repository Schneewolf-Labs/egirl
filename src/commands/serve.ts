import { type AgentFactory, createAgentLoop } from '../agent'
import { SessionMutex } from '../agent/session-mutex'
import { createAppServices } from '../bootstrap'
import { createDiscordChannel, createXMPPChannel } from '../channels'
import type { RuntimeConfig } from '../config'
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

  if (!discordConf && !xmppConf) {
    console.error(
      'Error: No channels configured. Configure channels.discord or channels.xmpp in egirl.toml to use serve mode, or run `bun run cli` instead.',
    )
    process.exit(1)
  }

  const {
    providers,
    memory,
    conversations,
    taskStore,
    toolExecutor,
    transcript,
    skills,
    processRegistry,
  } = await createAppServices(config)

  const standup = await gatherStandup(config.workspace.path)
  const sessionMutex = new SessionMutex()

  const active: string[] = []
  const shutdownFns: Array<() => Promise<void>> = []
  const outbound = new Map<string, { send(target: string, message: string): Promise<void> }>()

  const agentFactory: AgentFactory = (sessionId: string) =>
    createAgentLoop({
      config,
      toolExecutor,
      localProvider: providers.local,
      auxProvider: providers.auxiliary,
      sessionId,
      memory,
      conversationStore: conversations,
      transcript,
      skills,
      additionalContext: standup.context || undefined,
      sessionMutex,
    })

  // --- Discord ---
  let discord: ReturnType<typeof createDiscordChannel> | undefined
  let discordDefaultTarget = 'dm'
  if (discordConf) {
    discord = createDiscordChannel(agentFactory, discordConf, providers.local)
    discordDefaultTarget = discordConf.allowedChannels[0] ?? 'dm'
    outbound.set('discord', discord)
    shutdownFns.push(async () => discord?.stop())
    active.push('discord')
  }

  // --- XMPP ---
  // XMPP uses a single long-lived session — the local model driving one chat stream.
  let xmpp: ReturnType<typeof createXMPPChannel> | undefined
  if (xmppConf) {
    const xmppAgent = agentFactory('xmpp:default')
    xmpp = createXMPPChannel(xmppAgent, xmppConf)
    outbound.set('xmpp', {
      send: async (target, message) => xmpp?.sendTo(target, message),
    })
    shutdownFns.push(async () => xmpp?.stop())
    active.push('xmpp')
  }

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
      transcript,
      outbound,
      conversationStore: conversations,
      sessionMutex,
    })

    // Default task channel: prefer discord if configured, otherwise xmpp
    const defaultChannel = discord ? 'discord' : 'xmpp'
    const defaultTarget = discord ? discordDefaultTarget : (xmppConf?.allowedJids[0] ?? 'self')

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
        transcript,
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
    for (const fn of shutdownFns) {
      await fn().catch(() => {})
    }
    await processRegistry.shutdownAll()
    taskStore?.close()
    conversations?.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  if (discord) await discord.start()
  if (xmpp) await xmpp.start()
  taskRunner?.start()
  discovery?.start()

  log.info('main', `Serving: ${active.join(' + ')}. Press Ctrl+C to stop.`)
}
