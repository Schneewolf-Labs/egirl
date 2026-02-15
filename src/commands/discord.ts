import { type AgentFactory, createAgentLoop } from '../agent'
import { SessionMutex } from '../agent/session-mutex'
import { createAppServices } from '../bootstrap'
import { createDiscordChannel } from '../channels'
import type { RuntimeConfig } from '../config'
import { gatherStandup } from '../standup'
import { createDiscovery, createTaskRunner } from '../tasks'
import { createTaskTools } from '../tools/builtin/tasks'
import { applyLogLevel } from '../util/args'
import { log } from '../util/logger'

export async function runDiscord(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)

  if (!config.channels.discord) {
    console.error(
      'Error: Discord not configured. Add DISCORD_TOKEN to .env and configure channels.discord in egirl.toml',
    )
    process.exit(1)
  }

  const { providers, memory, conversations, taskStore, router, toolExecutor, skills } =
    await createAppServices(config)

  // Gather workspace standup for agent context
  const standup = await gatherStandup(config.workspace.path)

  // Shared mutex serializes agent runs across Discord messages and background tasks
  const sessionMutex = new SessionMutex()

  // Create agent factory for per-session loops
  const agentFactory: AgentFactory = (sessionId: string) =>
    createAgentLoop({
      config,
      router,
      toolExecutor,
      localProvider: providers.local,
      remoteProvider: providers.remote,
      sessionId,
      memory,
      conversationStore: conversations,
      skills,
      additionalContext: standup.context || undefined,
      sessionMutex,
    })

  const discord = createDiscordChannel(agentFactory, config.channels.discord, providers.local)

  // Set up background task runner if task store is available
  let taskRunner: ReturnType<typeof createTaskRunner> | undefined
  let discovery: ReturnType<typeof createDiscovery> | undefined

  if (taskStore && config.tasks.enabled) {
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
      outbound,
      sessionMutex,
    })

    // Register task tools on the shared tool executor
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

    // Wire up proposal approval via reactions
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

    // Set up discovery if enabled
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
      })
    }

    log.info('main', 'Background task system initialized')
  }

  // Handle graceful shutdown
  const shutdown = async () => {
    log.info('main', 'Shutting down...')
    discovery?.stop()
    taskRunner?.stop()
    await discord.stop()
    taskStore?.close()
    conversations?.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await discord.start()

  // Start task runner and discovery after channel is connected
  taskRunner?.start()
  discovery?.start()

  log.info('main', 'Discord bot running. Press Ctrl+C to stop.')
}
