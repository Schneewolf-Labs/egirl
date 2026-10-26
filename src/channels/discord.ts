import {
  ChannelType,
  type ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  Partials,
  type PartialUser,
  type User,
} from 'discord.js'
import type { AgentFactory } from '../agent'
import type { Operator } from '../operator/types'
import type { LLMProvider } from '../providers/types'
import type { ReplyBroker } from '../report/broker'
import { type Caller, customCommands, isCommand } from '../session/commands'
import { EngagementTracker } from '../session/engagement'
import type { Skill } from '../skills/types'
import { log } from '../util/logger'
import { describeAllowList, isAllowedByList } from './allowlist'
import {
  type BufferedMessage,
  evaluateRelevance,
  formatBatchForAgent,
  MessageBatcher,
} from './discord/batch-evaluator'
import {
  buildApplicationCommands,
  callerFor,
  registerApplicationCommands,
} from './discord-commands'
import { type DiscordFile, withImages } from './discord-images'
import { CARD_COLORS } from './rich'
import { deliver, runTurn, type Surface } from './spine'
import type { ChatChannel, RichCard } from './types'

export interface DiscordConfig {
  token: string
  allowedChannels: string[] // Channel IDs or 'dm' for DMs
  allowedUsers: string[] // User IDs (empty = allow all)
  ownerUsers: string[] // User IDs who may run owner-only commands
  passiveChannels: string[] // Channel IDs to passively monitor (respond without being tagged)
  batchWindowMs: number // Debounce window before evaluating a batch (ms)
  attachImagesFrom?: string[] // URL prefixes whose markdown images are uploaded as attachments
  workspacePath?: string // Her workspace dir; markdown images pointing inside it are attached
  builtinPermission?: 'everyone' | 'allowed' | 'owner' // who may run /think, /status, /context, /settings
  // Engagement policy for passive channels (see src/session/engagement.ts). When wakeWords is
  // non-empty or requireWake is false, these replace the relevance-model gate with deterministic
  // wake-word + conversation-window rules; otherwise the legacy local-model gate is used.
  wakeWords?: string[] // Names that wake her in a passive channel (empty = use the relevance model)
  conversationWindowMs?: number // How long a reply keeps the conversation open without a wake word
  requireWake?: boolean // false: engage on every message in a passive channel (it is hers alone)
}

const DISCORD_MAX_MESSAGE_LENGTH = 2000

export interface ReactionEvent {
  emoji: string
  userId: string
  messageId: string
  isBot: boolean
}

export type ReactionHandler = (event: ReactionEvent) => void | Promise<void>

/**
 * Whether a message's channel is in a configured list. A thread counts through its parent;
 * a DM matches only the given marker (or never, when there is none).
 */
function channelListed(message: Message, list: string[], dmMarker: string | undefined): boolean {
  if (message.channel.type === ChannelType.DM)
    return dmMarker !== undefined && list.includes(dmMarker)
  if (list.includes(message.channel.id)) return true
  if ('parentId' in message.channel && message.channel.parentId) {
    return list.includes(message.channel.parentId)
  }
  return false
}

/** Build a Discord embed from a transport-agnostic card, clamped to Discord's field limits. */
function buildEmbed(card: RichCard): EmbedBuilder {
  const embed = new EmbedBuilder()
  if (card.title) embed.setTitle(card.title.slice(0, 256))
  if (card.text) embed.setDescription(card.text.slice(0, 4096))
  if (card.url) embed.setURL(card.url)
  if (card.status) embed.setColor(CARD_COLORS[card.status])
  if (card.footer) embed.setFooter({ text: card.footer.slice(0, 2048) })
  if (card.fields?.length) {
    embed.addFields(
      card.fields.slice(0, 25).map((f) => ({
        name: f.name.slice(0, 256) || '​',
        value: f.value.slice(0, 1024) || '​',
        inline: f.inline ?? false,
      })),
    )
  }
  return embed
}

export class DiscordChannel implements ChatChannel {
  readonly name = 'discord'
  private client: Client
  private agentFactory: AgentFactory
  /** Skills the agent was built with; the ones declaring `egirl.command` become slash commands. */
  private readonly skills: Skill[]
  private sessions: Map<string, Operator> = new Map()
  private config: DiscordConfig
  private ready = false
  private reactionHandlers: ReactionHandler[] = []
  private messageQueue: Array<() => Promise<void>> = []
  private processing = false
  private batcher: MessageBatcher | null = null
  private engagement: EngagementTracker | null = null
  private localProvider: LLMProvider | null = null
  private broker: ReplyBroker | undefined

  constructor(
    agentFactory: AgentFactory,
    config: DiscordConfig,
    localProvider?: LLMProvider,
    broker?: ReplyBroker,
    skills: Skill[] = [],
  ) {
    this.agentFactory = agentFactory
    this.config = config
    this.broker = broker
    this.skills = skills

    if (config.passiveChannels.length > 0) {
      this.batcher = new MessageBatcher({ windowMs: config.batchWindowMs }, (channelId, messages) =>
        this.handleBatch(channelId, messages),
      )
      const engagementEnabled = (config.wakeWords?.length ?? 0) > 0 || config.requireWake === false
      if (engagementEnabled) {
        // Deterministic wake-word + conversation-window gating. No model call; see engagement.ts.
        const conversationWindowMs = config.conversationWindowMs ?? 120_000
        const requireWake = config.requireWake ?? true
        this.engagement = new EngagementTracker({
          wakeWords: config.wakeWords ?? [],
          conversationWindowMs,
          requireWake,
        })
        log.info(
          'discord',
          `Engagement policy on ${config.passiveChannels.length} channel(s): wake=[${(config.wakeWords ?? []).join(', ')}], window=${conversationWindowMs}ms, requireWake=${requireWake}`,
        )
      } else if (localProvider) {
        // Legacy behavior: a local model decides whether to join each buffered batch.
        this.localProvider = localProvider
        log.info(
          'discord',
          `Passive monitoring (relevance model) enabled for ${config.passiveChannels.length} channel(s), batch window ${config.batchWindowMs}ms`,
        )
      } else {
        log.warn(
          'discord',
          `passive_channels set but neither wake_words nor a local model is available — nothing will trigger in them`,
        )
      }
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [
        Partials.Channel, // Required for DMs
        Partials.Message,
        Partials.Reaction,
      ],
    })

    this.setupEventHandlers()
  }

  /** Register a handler called when a reaction is added to any message */
  onReaction(handler: ReactionHandler): void {
    this.reactionHandlers.push(handler)
  }

  private setupEventHandlers(): void {
    this.client.once(Events.ClientReady, (client) => {
      this.ready = true
      log.info('discord', `Logged in as ${client.user.tag}`)
      // Cosmetic registration: the same vocabulary as typed text, offered with autocomplete.
      void registerApplicationCommands(
        client,
        this.config.token,
        buildApplicationCommands(customCommands(this.skills)),
      )
      log.info('discord', `Allowed channels: ${this.config.allowedChannels.join(', ')}`)
      log.info('discord', `Users allowed: ${describeAllowList(this.config.allowedUsers)}`)
      if (this.config.allowedUsers.length === 0) {
        log.warn(
          'discord',
          'Empty allow-list: refusing every sender. Set [channels.discord].allowed_users (or "*" to allow anyone).',
        )
      }
    })

    this.client.on(Events.MessageCreate, async (message) => {
      await this.handleMessage(message)
    })

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return
      await this.handleSlash(interaction).catch((error) =>
        log.error('discord', 'Slash command failed:', error),
      )
    })

    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      await this.handleReaction(reaction, user)
    })

    this.client.on(Events.Error, (error) => {
      log.error('discord', 'Client error:', error)
    })
  }

  private async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    // Fetch partial reaction/message if needed
    if (reaction.partial) {
      try {
        await reaction.fetch()
      } catch (error) {
        log.debug('discord', 'Failed to fetch partial reaction:', error)
        return
      }
    }

    const emoji = reaction.emoji.name ?? reaction.emoji.id ?? 'unknown'
    const isBot = user.bot ?? false

    log.debug('discord', `Reaction ${emoji} from ${user.id} on ${reaction.message.id}`)

    const event: ReactionEvent = {
      emoji,
      userId: user.id,
      messageId: reaction.message.id,
      isBot,
    }

    for (const handler of this.reactionHandlers) {
      try {
        await handler(event)
      } catch (error) {
        log.error('discord', 'Reaction handler error:', error)
      }
    }
  }

  private resolveSessionKey(message: Message): string {
    if (message.channel.type === ChannelType.DM) {
      return `discord:dm:${message.author.id}`
    }
    if (
      message.channel.type === ChannelType.PublicThread ||
      message.channel.type === ChannelType.PrivateThread ||
      message.channel.type === ChannelType.AnnouncementThread
    ) {
      return `discord:thread:${message.channel.id}`
    }
    return `discord:channel:${message.channel.id}`
  }

  private getOrCreateAgent(sessionKey: string): Operator {
    let agent = this.sessions.get(sessionKey)
    if (!agent) {
      agent = this.agentFactory(sessionKey)
      this.sessions.set(sessionKey, agent)
      log.debug('discord', `Created agent for session ${sessionKey}`)
    }
    return agent
  }

  private async handleMessage(message: Message): Promise<void> {
    // Ignore bot messages (including our own)
    if (message.author.bot) return

    // Check if user is allowed
    if (!this.isUserAllowed(message.author.id)) {
      log.debug('discord', `Ignoring message from non-allowed user: ${message.author.tag}`)
      return
    }

    // A pending report ask on this channel consumes the message as its answer — no mention
    // needed: the human is replying to the agent's question, not starting a new turn.
    if (this.broker?.tryDeliver('discord', message.channel.id, message.content.trim())) return

    const isMentioned = this.isMentioned(message)
    const isPassive = this.isPassiveChannel(message)

    // Check if channel is allowed (passive channels are implicitly allowed)
    if (!isPassive && !this.isChannelAllowed(message)) {
      return
    }

    // Get the message content (strip bot mention if present)
    const content = this.extractContent(message)

    // A command answers at once, ahead of whatever turn the queue is waiting on -- asking
    // whether she is busy must not itself wait until she is not. A custom command that expands
    // into a turn queues behind the turn in flight on the loop itself (Operator.run). Commands
    // are handled even in a passive channel, so the engagement gate never swallows one.
    if (content.trim() && isCommand(content)) {
      this.processMessage(message, content).catch((error) => {
        log.error('discord', 'Command failed:', error)
      })
      return
    }

    // Passive channel: decide engagement, then buffer so a burst coalesces into one turn.
    if (isPassive && this.batcher) {
      if (this.engagement) {
        // Scan the raw text for a wake word; a direct @mention counts as addressed.
        const decision = this.engagement.consider({
          conversationId: message.channel.id,
          text: message.content,
          addressed: isMentioned,
        })
        if (!decision.engage) {
          log.debug('discord', `Staying quiet in ${message.channel.id} (${decision.reason})`)
          return
        }
        const buffered = content.trim()
        if (!buffered) return
        log.debug('discord', `Engaging in ${message.channel.id} (${decision.reason}); buffering`)
        this.batcher.add(message.channel.id, {
          author: message.author.displayName ?? message.author.username,
          authorId: message.author.id,
          content: buffered,
          timestamp: message.createdAt,
          message,
        })
        return
      }

      // Legacy relevance-model path: buffer non-mentions; a mention flushes and runs now.
      if (message.guild && !isMentioned) {
        const buffered = content.trim()
        if (!buffered) return
        log.debug(
          'discord',
          `Buffering passive message from ${message.author.tag} in ${message.channel.id}`,
        )
        this.batcher.add(message.channel.id, {
          author: message.author.displayName ?? message.author.username,
          authorId: message.author.id,
          content: buffered,
          timestamp: message.createdAt,
          message,
        })
        return
      }
      this.batcher.flushNow(message.channel.id)
    }

    // A non-passive guild channel only responds when mentioned; DMs always respond.
    if (!isPassive && message.guild && !isMentioned) return

    if (!content.trim()) return

    // Enqueue to prevent concurrent access to shared Operator context
    this.enqueueMessage(() => this.processMessage(message, content))
  }

  private enqueueMessage(task: () => Promise<void>): void {
    this.messageQueue.push(task)
    if (!this.processing) {
      this.drainQueue()
    }
  }

  private async drainQueue(): Promise<void> {
    this.processing = true
    while (this.messageQueue.length > 0) {
      const task = this.messageQueue.shift()
      if (!task) break
      try {
        await task()
      } catch (error) {
        log.error('discord', 'Queued message processing failed:', error)
      }
    }
    this.processing = false
  }

  /** A reply chunk, with allowed markdown images uploaded as attachments (see discord-images). */
  private async payload(
    chunk: string,
  ): Promise<string | { content?: string; files: DiscordFile[] }> {
    const p = await withImages(chunk, this.config.attachImagesFrom ?? [], this.config.workspacePath)
    if (p.files.length === 0) return chunk
    return { ...(p.content ? { content: p.content } : {}), files: p.files }
  }

  private async processMessage(message: Message, content: string): Promise<void> {
    log.info('discord', `Message from ${message.author.tag}: ${content.slice(0, 100)}...`)

    const sessionKey = this.resolveSessionKey(message)
    const agent = this.getOrCreateAgent(sessionKey)
    const channel = message.channel

    // The first piece is a reply to the triggering message; the rest follow as plain sends.
    let replied = false
    await runTurn(
      agent,
      {
        channel: 'discord',
        target: channel.id,
        maxLength: DISCORD_MAX_MESSAGE_LENGTH,
        format: 'markdown',
        send: async (chunk) => {
          if (!replied) {
            replied = true
            await message.reply(await this.payload(chunk))
          } else if ('send' in channel) {
            await channel.send(await this.payload(chunk))
          }
        },
        // Discord has no explicit "stopped typing"; the indicator lapses once a message lands.
        typing: {
          refreshMs: 8_000,
          set: async (on) => {
            if (on && 'sendTyping' in channel) await channel.sendTyping()
          },
        },
        ack: this.reactionAck(message),
      },
      content,
      this.broker,
      {
        skills: this.skills,
        caller: this.callerOf(message.author.id),
        builtinPermission: this.config.builtinPermission,
      },
    )
  }

  private callerOf(userId: string): Caller {
    return callerFor(userId, this.config)
  }

  /**
   * Acknowledgement reactions on the triggering message: 👀 while she works, swapped for ✅ when
   * the reply lands or ⚠️ if the turn errored. A cheap, wordless "I saw you / I'm done" cue. All
   * cosmetic — a missing permission or a deleted message must never fail the turn.
   */
  private reactionAck(message: Message): Surface['ack'] {
    const EMOJI = { working: '👀', done: '✅', failed: '⚠️' } as const
    const clear = async (emoji: string): Promise<void> => {
      const uid = this.client.user?.id
      if (!uid) return
      await message.reactions.cache.get(emoji)?.users.remove(uid)
    }
    return {
      working: () => message.react(EMOJI.working).then(() => {}),
      done: async () => {
        await clear(EMOJI.working).catch(() => {})
        await message.react(EMOJI.done)
      },
      failed: async () => {
        await clear(EMOJI.working).catch(() => {})
        await message.react(EMOJI.failed)
      },
    }
  }

  /**
   * A slash interaction is the same text a user could have typed, run through the same
   * dispatcher on the same session. Discord wants an acknowledgement within three seconds,
   * so the reply is deferred and the first chunk edits it; further chunks follow up.
   */
  private async handleSlash(interaction: ChatInputCommandInteraction): Promise<void> {
    const args = interaction.options.getString('args') ?? ''
    const text = `/${interaction.commandName}${args ? ` ${args}` : ''}`
    if (
      !this.isUserAllowed(interaction.user.id) &&
      !this.config.ownerUsers.includes(interaction.user.id)
    ) {
      await interaction.reply({ content: '🔒 not for you', ephemeral: true })
      return
    }
    const channelId = interaction.channelId
    // Same session the typed form would land in (see resolveSessionKey).
    const agent = this.getOrCreateAgent(
      interaction.inGuild() ? `discord:channel:${channelId}` : `discord:dm:${interaction.user.id}`,
    )
    await interaction.deferReply()
    let first = true
    await runTurn(
      agent,
      {
        channel: 'discord',
        target: channelId,
        maxLength: DISCORD_MAX_MESSAGE_LENGTH,
        format: 'markdown',
        send: async (chunk) => {
          if (first) {
            first = false
            await interaction.editReply(await this.payload(chunk))
          } else await interaction.followUp(await this.payload(chunk))
        },
      },
      text,
      this.broker,
      {
        skills: this.skills,
        caller: this.callerOf(interaction.user.id),
        builtinPermission: this.config.builtinPermission,
      },
    )
  }

  private isUserAllowed(userId: string): boolean {
    return isAllowedByList(this.config.allowedUsers, (entry) => entry === userId)
  }

  private isChannelAllowed(message: Message): boolean {
    return channelListed(message, this.config.allowedChannels, 'dm')
  }

  /** DMs are never passive. */
  private isPassiveChannel(message: Message): boolean {
    return channelListed(message, this.config.passiveChannels, undefined)
  }

  /**
   * Called when the batcher's debounce timer fires for a passive channel. Under the engagement
   * policy the decision to respond was already made deterministically when the messages were
   * buffered, so the batch just runs; the window is reopened once she replies so follow-ups
   * carry on without a fresh wake word. Without engagement, the legacy relevance model decides.
   */
  private async handleBatch(channelId: string, messages: BufferedMessage[]): Promise<void> {
    if (messages.length === 0) return

    // The last message is the reply target; its author sees the response threaded to them.
    const lastMessage = messages[messages.length - 1]?.message
    if (!lastMessage) return

    if (this.engagement) {
      const input = this.engagedInput(messages)
      this.enqueueMessage(() =>
        this.processMessage(lastMessage, input).finally(() => {
          this.engagement?.noteReply(channelId)
        }),
      )
      return
    }

    if (!this.localProvider) return
    const botName = this.client.user?.displayName ?? this.client.user?.username ?? 'Kira'
    log.debug(
      'discord',
      `Evaluating batch of ${messages.length} message(s) in channel ${channelId}`,
    )

    const decision = await evaluateRelevance(this.localProvider, messages, botName)
    if (!decision.shouldRespond) {
      log.debug('discord', `Skipping batch in ${channelId}: ${decision.reason}`)
      return
    }

    log.info('discord', `Responding to batch in ${channelId}: ${decision.reason}`)
    const agentInput = formatBatchForAgent(messages)
    this.enqueueMessage(() => this.processMessage(lastMessage, agentInput))
  }

  /**
   * Turn an engaged batch into one agent input. A single message is passed verbatim — in her
   * own channel she is simply being spoken to, not "monitoring" one. Several messages are
   * labelled by author so she can tell a burst apart.
   */
  private engagedInput(messages: BufferedMessage[]): string {
    if (messages.length === 1) return messages[0]?.content ?? ''
    return messages.map((m) => `${m.author}: ${m.content}`).join('\n')
  }

  private isMentioned(message: Message): boolean {
    if (!this.client.user) return false
    return message.mentions.has(this.client.user)
  }

  private extractContent(message: Message): string {
    let content = message.content

    // Remove bot mention from the beginning
    if (this.client.user) {
      const mentionRegex = new RegExp(`^<@!?${this.client.user.id}>\\s*`, 'i')
      content = content.replace(mentionRegex, '')
    }

    return content.trim()
  }

  /** Outbound: send a message to a channel or user without an inbound trigger */
  async send(target: string, message: string): Promise<void> {
    if (!this.ready) {
      log.warn('discord', `Cannot send outbound message: client not ready`)
      return
    }

    try {
      const channel = await this.client.channels.fetch(target)
      if (channel?.isTextBased() && 'send' in channel) {
        await deliver(
          {
            maxLength: DISCORD_MAX_MESSAGE_LENGTH,
            send: async (chunk) => {
              await channel.send(await this.payload(chunk))
            },
          },
          message,
        )
      } else {
        log.warn('discord', `Channel ${target} not found or not text-based`)
      }
    } catch (err) {
      log.error('discord', `Failed to send outbound message to ${target}: ${err}`)
    }
  }

  /** Outbound: deliver a structured card as a Discord embed (see rich.ts / sendCardOrText). */
  async sendCard(target: string, card: RichCard): Promise<void> {
    if (!this.ready) {
      log.warn('discord', 'Cannot send outbound card: client not ready')
      return
    }
    try {
      const channel = await this.client.channels.fetch(target)
      if (channel?.isTextBased() && 'send' in channel) {
        await channel.send({ embeds: [buildEmbed(card)] })
      } else {
        log.warn('discord', `Channel ${target} not found or not text-based`)
      }
    } catch (err) {
      log.error('discord', `Failed to send card to ${target}: ${err}`)
    }
  }

  async start(): Promise<void> {
    log.info('discord', 'Starting Discord bot...')
    await this.client.login(this.config.token)
  }

  async stop(): Promise<void> {
    log.info('discord', 'Stopping Discord bot...')
    this.batcher?.clear()
    this.client.destroy()
    this.ready = false
  }
}

export function createDiscordChannel(
  agentFactory: AgentFactory,
  config: DiscordConfig,
  localProvider?: LLMProvider,
  broker?: ReplyBroker,
  skills: Skill[] = [],
): DiscordChannel {
  return new DiscordChannel(agentFactory, config, localProvider, broker, skills)
}
