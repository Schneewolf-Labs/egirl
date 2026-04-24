import { type AgentFactory, type AgentLoop, createAgentLoop } from '../agent'
import { SessionMutex } from '../agent/session-mutex'
import { startAPIServer } from '../api'
import { createAppServices } from '../bootstrap'
import type { RuntimeConfig } from '../config'
import { gatherStandup } from '../standup'
import { createTaskRunner } from '../tasks'
import { createTaskTools } from '../tools/builtin/tasks'
import { applyLogLevel } from '../util/args'
import { log } from '../util/logger'

export async function runAPI(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)

  if (!config.channels.api) {
    console.error(
      'Error: API not configured. Add [channels.api] to egirl.toml (and optionally EGIRL_API_TOKEN to .env).',
    )
    process.exit(1)
  }

  const { providers, memory, conversations, taskStore, toolExecutor, transcript, skills } =
    await createAppServices(config)

  const standup = await gatherStandup(config.workspace.path)
  const sessionMutex = new SessionMutex()

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

  const agents = new Map<string, AgentLoop>()

  // Background tasks are optional but naturally pair with the API —
  // POST /tasks doesn't do much without a runner.
  let taskRunner: ReturnType<typeof createTaskRunner> | undefined
  if (taskStore && config.tasks.enabled && config.tools.tasks) {
    taskRunner = createTaskRunner({
      config,
      tasksConfig: config.tasks,
      store: taskStore,
      toolExecutor,
      localProvider: providers.local,
      memory,
      transcript,
      outbound: new Map(),
      conversationStore: conversations,
      sessionMutex,
    })

    const taskTools = createTaskTools(taskStore, taskRunner, config.tasks.maxActiveTasks, () => ({
      channel: 'api',
      channelTarget: 'api:default',
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

    taskRunner.start()
  }

  const server = startAPIServer(config.channels.api, {
    agentFactory,
    agents,
    memory,
    taskStore,
    taskRunner,
  })

  const shutdown = async () => {
    log.info('main', 'Shutting down...')
    taskRunner?.stop()
    server.stop()
    taskStore?.close()
    conversations?.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
