import {
  type ChatChannel,
  createDiscordChannel,
  createMatrixChannel,
  createTelegramChannel,
  createXMPPChannel,
} from '../channels'
import type { OutboundChannel } from '../channels/types'
import type { RuntimeConfig } from '../config'
import { createReplyBroker } from '../report/broker'
import { registerReportTool } from '../report/register'
import { applyLogLevel } from '../util/args'
import { errorMessage } from '../util/errors'
import { log } from '../util/logger'
import { createBackgroundTasks, createCommandRuntime, onShutdown } from './runtime'

export type ServeChannel = 'discord' | 'xmpp' | 'telegram' | 'matrix'

const CHANNEL_SETUP_HINTS: Record<ServeChannel, string> = {
  discord: 'Add DISCORD_TOKEN to .env and configure channels.discord in egirl.toml',
  xmpp: 'Add XMPP_USERNAME and XMPP_PASSWORD to .env and configure channels.xmpp in egirl.toml',
  telegram: 'Add TELEGRAM_BOT_TOKEN to .env and configure channels.telegram in egirl.toml',
  matrix:
    'Add MATRIX_ACCESS_TOKEN (or MATRIX_USERNAME and MATRIX_PASSWORD) to .env and configure channels.matrix in egirl.toml',
}

/**
 * Run the chat channels plus the background task runner in one process. With `only` set, run
 * just that channel (the `egirl discord` / `xmpp` / `telegram` / `matrix` commands).
 */
export async function runServe(
  config: RuntimeConfig,
  args: string[],
  only?: ServeChannel,
): Promise<void> {
  applyLogLevel(args)

  const want = (name: ServeChannel) => !only || only === name
  const discordConf = want('discord') ? config.channels.discord : undefined
  const xmppConf = want('xmpp') ? config.channels.xmpp : undefined
  const telegramConf = want('telegram') ? config.channels.telegram : undefined
  const matrixConf = want('matrix') ? config.channels.matrix : undefined

  if (!discordConf && !xmppConf && !telegramConf && !matrixConf) {
    console.error(
      only
        ? `Error: ${only} not configured. ${CHANNEL_SETUP_HINTS[only]}`
        : 'Error: No channels configured. Configure channels.discord, channels.xmpp, channels.telegram or channels.matrix in egirl.toml to use serve mode, or run `bun run cli` instead.',
    )
    process.exit(1)
  }

  const rt = await createCommandRuntime(config)
  const { providers, conversations, taskStore, toolExecutor, processRegistry, agentFactory } = rt

  const outbound = new Map<string, OutboundChannel>()
  // Routes inbound chat messages to pending report asks (see src/report/broker.ts).
  const replyBroker = createReplyBroker()

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

  const primary = chat[0]
  const tasks = createBackgroundTasks(rt, {
    outbound,
    channel: primary?.channel.name ?? 'discord',
    channelTarget: primary?.defaultTarget ?? 'self',
  })

  if (tasks && discord && taskStore) {
    // Proposal approval via reactions.
    discord.onReaction(async (event) => {
      if (event.isBot) return
      const proposal = taskStore.getProposalByMessage(event.messageId)
      if (!proposal) return

      if (event.emoji === '✅') {
        taskStore.update(proposal.taskId, { status: 'active' as const })
        taskStore.updateProposal(proposal.id, { status: 'approved' })
        tasks.taskRunner.activateTask(proposal.taskId)
        log.info('tasks', `Task ${proposal.taskId} approved via reaction`)
      }
      if (event.emoji === '❌') {
        taskStore.updateProposal(proposal.id, { status: 'rejected', rejectedAt: Date.now() })
        taskStore.delete(proposal.taskId)
        log.info('tasks', `Task ${proposal.taskId} rejected via reaction`)
      }
    })
  }

  onShutdown(async () => {
    tasks?.discovery?.stop()
    tasks?.taskRunner.stop()
    for (const { channel } of chat) {
      await channel.stop().catch(() => {})
    }
    await processRegistry.shutdownAll()
    taskStore?.close()
    conversations?.close()
  })

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
      const message = errorMessage(error)
      log.error('main', `Channel "${channel.name}" failed to start: ${message}`)
      // Shut the client down rather than leaving it to reconnect. Some failures never resolve
      // on their own -- a self-signed certificate will be just as self-signed a second later --
      // and the client's own retry loop will otherwise log an error every second forever,
      // burying everything else the instance has to say.
      await channel.stop().catch(() => {})
      log.warn('main', `Continuing without ${channel.name}.`)
    }
  }
  tasks?.taskRunner.start()
  tasks?.discovery?.start()

  if (!started.length) {
    log.warn('main', 'No channels started. Background tasks still run; chat is unavailable.')
  }
  log.info(
    'main',
    `Serving: ${started.join(' + ') || 'background tasks only'}. Press Ctrl+C to stop.`,
  )
}
