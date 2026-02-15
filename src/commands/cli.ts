import { createAgentLoop } from '../agent'
import { SessionMutex } from '../agent/session-mutex'
import { createAppServices } from '../bootstrap'
import { createCLIChannel } from '../channels'
import type { RuntimeConfig } from '../config'
import { gatherStandup } from '../standup'
import { createDiscovery, createTaskRunner } from '../tasks'
import { createTaskTools } from '../tools/builtin/tasks'
import { applyLogLevel } from '../util/args'
import { log } from '../util/logger'

export async function runCLI(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)

  // Check for single message mode
  const messageIndex = args.indexOf('-m')
  const singleMessage = messageIndex !== -1 ? args[messageIndex + 1] : null

  const { providers, memory, conversations, taskStore, router, toolExecutor, stats, skills } =
    await createAppServices(config)

  // Gather workspace standup for agent context
  const standup = await gatherStandup(config.workspace.path)

  // Shared mutex serializes agent runs across CLI input and background tasks
  const sessionMutex = new SessionMutex()

  // Create agent loop with conversation persistence and memory
  const sessionId = singleMessage ? crypto.randomUUID() : 'cli:default'
  const agent = createAgentLoop({
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

  // Single message mode — no task runner
  if (singleMessage) {
    try {
      const response = await agent.run(singleMessage)

      stats.recordRequest(
        response.target,
        response.provider,
        response.usage.input_tokens,
        response.usage.output_tokens,
        response.escalated,
      )

      console.log(response.content)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Error: ${message}`)
      process.exit(1)
    }
    return
  }

  // Interactive CLI mode
  const cli = createCLIChannel(agent)

  // Set up background task runner if task store is available
  let taskRunner: ReturnType<typeof createTaskRunner> | undefined
  let discovery: ReturnType<typeof createDiscovery> | undefined

  if (taskStore && config.tasks.enabled) {
    const outbound = new Map<string, { send(target: string, message: string): Promise<void> }>()
    outbound.set('cli', cli)

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
    const taskTools = createTaskTools(taskStore, taskRunner, config.tasks.maxActiveTasks, () => ({
      channel: 'cli',
      channelTarget: 'stdout',
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
    await cli.stop()
    taskStore?.close()
    conversations?.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await cli.start()

  // Start task runner and discovery after CLI is ready
  taskRunner?.start()
  discovery?.start()
}
