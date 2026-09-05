import { join } from 'node:path'
import type { AgentLoop } from '../agent'
import { startAPIServer } from '../api'
import { createMatrixOutbound } from '../channels/matrix'
import type { OutboundChannel } from '../channels/types'
import type { RuntimeConfig } from '../config'
import { createPushNotifier, generateVapidKeys, PushStore } from '../push'
import { createReplyBroker } from '../report/broker'
import { ConsoleInbox } from '../report/console-channel'
import { registerReportTool } from '../report/register'
import { taskRunnerOffReason } from '../tasks'
import { applyLogLevel } from '../util/args'
import { createBackgroundTasks, createCommandRuntime, onShutdown } from './runtime'

export async function runAPI(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)

  if (!config.channels.api) {
    console.error(
      'Error: API not configured. Add [channels.api] to egirl.toml (and optionally EGIRL_API_TOKEN to .env).',
    )
    process.exit(1)
  }

  const rt = await createCommandRuntime(config)
  const { memory, conversations, taskStore, toolExecutor, processRegistry, agentFactory } = rt

  const agents = new Map<string, AgentLoop>()

  // The console is a real report target. Without this, an instance whose only surface is the
  // browser had nowhere to escalate to -- a peer supervisor worked, but "this one is the
  // human's call" died in a tool error, and the agent went back to guessing.
  const consoleInbox = new ConsoleInbox(config.source.instance ?? 'egirl')
  const replyBroker = createReplyBroker()
  // Matrix is send-only here: serve owns the room conversation, but a task or a report that
  // runs in this process still has to reach the room the human actually reads.
  const outbound = new Map<string, OutboundChannel>([['console', { send: consoleInbox.send }]])
  const matrix = config.channels.matrix ? createMatrixOutbound(config.channels.matrix) : undefined
  if (matrix) outbound.set('matrix', matrix)
  registerReportTool(config, toolExecutor, outbound, replyBroker)

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
  // POST /tasks doesn't do much without a runner. No discovery or heartbeat here: the API has
  // no chat surface for them to report into.
  const tasks = createBackgroundTasks(rt, {
    // Task notifications for api-channel tasks land in the console inbox as dismissable
    // notices — without a sender here they were warn-logged and never seen. A task created
    // from the room reports back to the room.
    outbound: new Map<string, OutboundChannel>([
      ['api', { send: consoleInbox.notice }],
      ...(matrix ? [['matrix', matrix] as const] : []),
    ]),
    channel: 'api',
    channelTarget: 'api:default',
    // A parked task is the one thing worth interrupting someone for: the agent has stopped
    // and nothing moves until a human answers.
    onAwaitingInput: (task) => {
      void push.notify(`task "${task.name}" is awaiting input`)
    },
    schedule: false,
  })
  const taskRunner = tasks?.taskRunner
  taskRunner?.start()

  const server = startAPIServer(config.channels.api, {
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

  onShutdown(async () => {
    taskRunner?.stop()
    server.stop()
    await matrix?.stop()
    await processRegistry.shutdownAll()
    taskStore?.close()
    conversations?.close()
  })
}
