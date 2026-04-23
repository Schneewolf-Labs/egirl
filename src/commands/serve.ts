import { type AgentFactory, createAgentLoop } from '../agent'
import { SessionMutex } from '../agent/session-mutex'
import { createAppServices } from '../bootstrap'
import { createDiscordChannel } from '../channels'
import type { RuntimeConfig } from '../config'
import { gatherStandup } from '../standup'
import { createDiscovery, createTaskRunner, seedHeartbeatTask } from '../tasks'
import { createTaskTools } from '../tools/builtin/tasks'
import { applyLogLevel } from '../util/args'
import { log } from '../util/logger'

export async function runServe(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)

  const discordConf = config.channels.discord

  if (!discordConf) {
    console.error(
      'Error: No channels configured. Configure channels.discord in egirl.toml to use serve mode, or run `bun run cli` instead.',
    )
    process.exit(1)
  }

  const { providers, memory, conversations, taskStore, toolExecutor, transcript, skills } =
    await createAppServices(config)

  const standup = await gatherStandup(config.workspace.path)
  const sessionMutex = new SessionMutex()

  const shutdownFns: Array<() => Promise<void>> = []

  const agentFactory: AgentFactory = (sessionId: string) =>
    createAgentLoop({
      config,
      toolExecutor,
      localProvider: providers.local,
      sessionId,
      memory,
      conversationStore: conversations,
      transcript,
      skills,
      additionalContext: standup.context || undefined,
      sessionMutex,
    })

  const discord = createDiscordChannel(agentFactory, discordConf, providers.local)

  let taskRunner: ReturnType<typeof createTaskRunner> | undefined
  let discovery: ReturnType<typeof createDiscovery> | undefined

  if (taskStore && config.tasks.enabled && config.tools.tasks) {
    const outbound = new Map<string, { send(target: string, message: string): Promise<void> }>()
    outbound.set('discord', discord)

    taskRunner = createTaskRunner({
      config,
      tasksConfig: config.tasks,
      store: taskStore,
      toolExecutor,
      localProvider: providers.local,
      memory,
      transcript,
      outbound,
      conversationStore: conversations,
      sessionMutex,
    })

    const defaultTarget = discordConf.allowedChannels[0] ?? 'dm'
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

  shutdownFns.push(async () => discord.stop())

  const shutdown = async () => {
    log.info('main', 'Shutting down...')
    discovery?.stop()
    taskRunner?.stop()
    for (const fn of shutdownFns) {
      await fn().catch(() => {})
    }
    taskStore?.close()
    conversations?.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await discord.start()
  taskRunner?.start()
  discovery?.start()

  log.info('main', 'Discord + tasks serving. Press Ctrl+C to stop.')
}
