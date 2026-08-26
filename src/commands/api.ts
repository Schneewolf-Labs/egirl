import { join } from 'node:path'
import { type AgentFactory, type AgentLoop, createAgentLoop } from '../agent'
import { SessionMutex } from '../agent/session-mutex'
import { startAPIServer } from '../api'
import { createAppServices } from '../bootstrap'
import type { RuntimeConfig } from '../config'
import { createPushNotifier, generateVapidKeys, PushStore } from '../push'
import { createReplyBroker } from '../report/broker'
import { ConsoleInbox } from '../report/console-channel'
import { registerReportTool } from '../report/register'
import { gatherStandup } from '../standup'
import { createTaskRunner, taskRunnerEnabled, taskRunnerOffReason } from '../tasks'
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

  const agents = new Map<string, AgentLoop>()

  // The console is a real report target. Without this, an instance whose only surface is the
  // browser had nowhere to escalate to -- a peer supervisor worked, but "this one is the
  // human's call" died in a tool error, and the agent went back to guessing.
  const consoleInbox = new ConsoleInbox(config.source.instance ?? 'egirl')
  const replyBroker = createReplyBroker()
  registerReportTool(
    config,
    toolExecutor,
    new Map([['console', { send: consoleInbox.send }]]),
    replyBroker,
  )

  // Web Push. Keys and subscriptions live in the workspace beside the other state, so an
  // instance keeps its identity across restarts -- regenerating the VAPID pair would silently
  // invalidate every subscription a browser has already bound to the old key.
  const pushStore = new PushStore(join(config.workspace.path, 'push.db'))
  const push = createPushNotifier(
    pushStore,
    pushStore.keys(generateVapidKeys),
    `mailto:egirl@${config.source.instance ?? 'localhost'}`,
  )

  // Background tasks are optional but naturally pair with the API —
  // POST /tasks doesn't do much without a runner.
  let taskRunner: ReturnType<typeof createTaskRunner> | undefined
  if (taskRunnerEnabled(config, !!taskStore) && taskStore) {
    taskRunner = createTaskRunner({
      config,
      tasksConfig: config.tasks,
      store: taskStore,
      // A parked task is the one thing worth interrupting someone for: the agent has stopped
      // and nothing moves until a human answers.
      onAwaitingInput: (task) => {
        void push.notify(`task "${task.name}" is awaiting input`)
      },
      toolExecutor,
      localProvider: providers.local,
      auxProvider: providers.auxiliary,
      memory,
      transcript,
      // Task notifications for api-channel tasks land in the console inbox as dismissable
      // notices — without a sender here they were warn-logged and never seen.
      outbound: new Map([['api', { send: consoleInbox.notice }]]),
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

  const server = startAPIServer(config.channels.api, {
    // A grinding background task makes the instance busy; the server's own in-flight runs are
    // tracked internally. The session mutex is not used here -- it guards only tool execution.
    isBusy: () => taskRunner?.isRunning() ?? false,
    consoleInbox,
    replyBroker,
    push,
    pushStore,
    agentFactory,
    agents,
    memory,
    taskStore,
    taskRunner,
    ...(taskRunner ? {} : { taskOffReason: taskRunnerOffReason(config, !!taskStore) }),
    config,
    selfName: config.source.instance ?? 'egirl',
    ...(conversations ? { conversationStore: conversations } : {}),
  })

  const shutdown = async () => {
    log.info('main', 'Shutting down...')
    taskRunner?.stop()
    server.stop()
    await processRegistry.shutdownAll()
    taskStore?.close()
    conversations?.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
