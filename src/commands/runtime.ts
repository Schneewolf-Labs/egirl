import { type AgentFactory, createAgentLoop } from '../agent'
import { SessionMutex } from '../agent/session-mutex'
import { type AppServices, createAppServices } from '../bootstrap'
import type { OutboundChannel } from '../channels/types'
import type { RuntimeConfig } from '../config'
import { MAIL_CHANNEL } from '../peers/mailbox-poll'
import { createMailbox, type Mailbox } from '../peers/mailbox-setup'
import { gatherStandup } from '../standup'
import {
  createDiscovery,
  createTaskRunner,
  type Discovery,
  seedHeartbeatTask,
  type Task,
  type TaskRunner,
  taskRunnerEnabled,
  taskRunnerOffReason,
} from '../tasks'
import { seedMailboxTask } from '../tasks/mailbox-task'
import { createTaskTools } from '../tools/builtin/tasks'
import { log } from '../util/logger'

/**
 * Everything a command entrypoint needs before it can wire a channel: the app services, the
 * workspace standup, the mutex that serializes agent runs across channels and background tasks,
 * and a factory for per-session agent loops that already carries all of the above.
 */
export interface CommandRuntime extends AppServices {
  sessionMutex: SessionMutex
  agentFactory: AgentFactory
}

export async function createCommandRuntime(config: RuntimeConfig): Promise<CommandRuntime> {
  const services = await createAppServices(config)
  const standup = await gatherStandup(config.workspace.path)
  const sessionMutex = new SessionMutex()

  const agentFactory: AgentFactory = (sessionId: string) =>
    createAgentLoop({
      config,
      toolExecutor: services.toolExecutor,
      localProvider: services.providers.local,
      auxProvider: services.providers.auxiliary,
      sessionId,
      memory: services.memory,
      conversationStore: services.conversations,
      skills: services.skills,
      additionalContext: standup || undefined,
      sessionMutex,
    })

  return { ...services, sessionMutex, agentFactory }
}

export interface BackgroundTasksOptions {
  /** Where task output and reports go, keyed by channel name. */
  outbound: Map<string, OutboundChannel>
  /** Default destination for tasks created by the task tools and the heartbeat. */
  channel: string
  channelTarget: string
  onAwaitingInput?: (task: Task) => void
  /** Run the discovery loop (when enabled in config) and seed the heartbeat task. Default true. */
  schedule?: boolean
}

export interface BackgroundTasks {
  taskRunner: TaskRunner
  discovery: Discovery | undefined
}

/**
 * Wire the background task system onto a runtime: runner, task tools on the shared executor,
 * discovery and the heartbeat seed. Returns undefined -- after saying why -- when tasks are off.
 * The runner and discovery are created but not started; callers start them once their channel
 * is up so the first task does not race the connection.
 */
export function createBackgroundTasks(
  rt: CommandRuntime,
  opts: BackgroundTasksOptions,
): BackgroundTasks | undefined {
  const { config, taskStore } = rt
  if (!taskRunnerEnabled(config, !!taskStore) || !taskStore) {
    // Say WHY, naming the flag. A bare silence here means a populated [tasks] section that
    // simply never runs, which is exactly what happened in practice.
    const why = taskRunnerOffReason(config, !!taskStore)
    if (config.source.tasksConfiguredButGated) {
      log.warn('tasks', `[tasks] is configured but INERT: ${why}`)
    } else if (why) {
      log.info('tasks', `Background tasks off: ${why}`)
    }
    return undefined
  }

  const shared = {
    config,
    tasksConfig: config.tasks,
    store: taskStore,
    toolExecutor: rt.toolExecutor,
    localProvider: rt.providers.local,
    auxProvider: rt.providers.auxiliary,
    memory: rt.memory,
  }

  // The poll closes over the mailbox, which needs the runner to exist first.
  let mailbox: Mailbox | undefined
  const taskRunner = createTaskRunner({
    ...shared,
    outbound: opts.outbound,
    conversationStore: rt.conversations,
    sessionMutex: rt.sessionMutex,
    onAwaitingInput: opts.onAwaitingInput,
    pollMailbox: async () => (mailbox ? mailbox.poll() : 'Mailbox is not enabled'),
  })

  const taskTools = createTaskTools(taskStore, taskRunner, config.tasks.maxActiveTasks, () => ({
    channel: opts.channel,
    channelTarget: opts.channelTarget,
  }))
  rt.toolExecutor.registerAll(Object.values(taskTools))

  mailbox = createMailbox({
    config,
    toolExecutor: rt.toolExecutor,
    tasks: taskStore,
    runner: taskRunner,
    conversations: rt.conversations,
    outbound: opts.outbound,
    channel: opts.channel,
    channelTarget: opts.channelTarget,
  })
  if (mailbox && config.mailbox) {
    opts.outbound.set(MAIL_CHANNEL, mailbox.outbound)
    rt.toolExecutor.register(mailbox.delegateTool)
    // Seeded in every process that runs tasks, unlike the heartbeat: an API-only instance
    // still has an inbox, and the seed is idempotent.
    seedMailboxTask({
      store: taskStore,
      runner: taskRunner,
      schedule: config.mailbox.schedule,
      channel: opts.channel,
      channelTarget: opts.channelTarget,
    })
  }

  let discovery: Discovery | undefined
  if (opts.schedule !== false) {
    if (config.tasks.discoveryEnabled) {
      discovery = createDiscovery({ ...shared, runner: taskRunner })
    }
    seedHeartbeatTask({
      store: taskStore,
      runner: taskRunner,
      tasksConfig: config.tasks,
      heartbeatConfig: config.tasks.heartbeat,
      workspacePath: config.workspace.path,
      channel: opts.channel,
      channelTarget: opts.channelTarget,
    })
  }

  log.info('main', 'Background task system initialized')
  return { taskRunner, discovery }
}

/** Run `fn` once on SIGINT/SIGTERM, then exit. */
export function onShutdown(fn: () => Promise<void>): void {
  const shutdown = async () => {
    log.info('main', 'Shutting down...')
    await fn()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
