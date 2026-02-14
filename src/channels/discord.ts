import {
  Client,
  GatewayIntentBits,
  Partials,
  Message,
  ChannelType,
  Events,
  type MessageReaction,
  type User,
  type PartialMessageReaction,
  type PartialUser,
  type Interaction,
} from 'discord.js'
import type { AgentLoop, AgentFactory } from '../agent'
import type { LLMProvider } from '../providers/types'
import type { Channel } from './types'
import { createDiscordEventHandler, buildToolCallPrefix } from './discord/events'
import { splitMessage } from './discord/formatting'
import { MessageBatcher, evaluateRelevance, formatBatchForAgent, type BufferedMessage } from './discord/batch-evaluator'
import { log } from '../util/logger'

export interface DiscordConfig {
  token: string
  allowedChannels: string[]  // Channel IDs or 'dm' for DMs
  allowedUsers: string[]     // User IDs (empty = allow all)
  passiveChannels: string[]  // Channel IDs to passively monitor (respond without being tagged)
  batchWindowMs: number      // Debounce window before evaluating a batch (ms)
}

export interface ReactionEvent {
  emoji: string
  userId: string
  messageId: string
  isBot: boolean
}

export type ReactionHandler = (event: ReactionEvent) => void | Promise<void>
export type InteractionHandler = (interaction: Interaction) => void | Promise<void>

export class DiscordChannel implements Channel {
  readonly name = 'discord'
  private client: Client
  private agentFactory: AgentFactory
  private sessions: Map<string, AgentLoop> = new Map()
  private config: DiscordConfig
  private ready = false
  private reactionHandlers: ReactionHandler[] = []
  private interactionHandlers: InteractionHandler[] = []
  private messageQueue: Array<() => Promise<void>> = []
  private processing = false
  private batcher: MessageBatcher | null = null
  private localProvider: LLMProvider | null = null

  constructor(agentFactory: AgentFactory, config: DiscordConfig, localProvider?: LLMProvider) {
    this.agentFactory = agentFactory
    this.config = config

    if (config.passiveChannels.length > 0 && localProvider) {
      this.localProvider = localProvider
      this.batcher = new MessageBatcher(
        { windowMs: config.batchWindowMs },
        (channelId, messages) => this.handleBatch(channelId, messages)
      )
      log.info('discord', `Passive monitoring enabled for ${config.passiveChannels.length} channel(s), batch window ${config.batchWindowMs}ms`)
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
        Partials.Channel,  // Required for DMs
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

  /** Register a handler called when a Discord interaction occurs (slash commands, buttons, etc.) */
  onInteraction(handler: InteractionHandler): void {
    this.interactionHandlers.push(handler)
  }

  private setupEventHandlers(): void {
    this.client.once(Events.ClientReady, (client) => {
      this.ready = true
      log.info('discord', `Logged in as ${client.user.tag}`)
      log.info('discord', `Allowed channels: ${this.config.allowedChannels.join(', ')}`)
      if (this.config.allowedUsers.length > 0) {
        log.info('discord', `Allowed users: ${this.config.allowedUsers.join(', ')}`)
      } else {
        log.info('discord', 'All users allowed')
      }
    })

    this.client.on(Events.MessageCreate, async (message) => {
      await this.handleMessage(message)
    })

    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      await this.handleReaction(reaction, user)
    })

    this.client.on(Events.InteractionCreate, async (interaction) => {
      await this.handleInteraction(interaction)
    })

    this.client.on(Events.Error, (error) => {
      log.error('discord', 'Client error:', error)
    })
  }

  private async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
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

  private async handleInteraction(interaction: Interaction): Promise<void> {
    log.debug('discord', `Interaction ${interaction.type} from ${interaction.user.tag}`)

    for (const handler of this.interactionHandlers) {
      try {
        await handler(interaction)
      } catch (error) {
        log.error('discord', 'Interaction handler error:', error)
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

  private getOrCreateAgent(sessionKey: string): AgentLoop {
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

    const isMentioned = this.isMentioned(message)
    const isPassive = this.isPassiveChannel(message)

    // Check if channel is allowed (passive channels are implicitly allowed)
    if (!isPassive && !this.isChannelAllowed(message)) {
      return
    }

    // For guild channels without a mention
    if (message.guild && !isMentioned) {
      // Buffer for passive channels
      if (isPassive && this.batcher) {
        const content = message.content.trim()
        if (!content) return

        log.debug('discord', `Buffering passive message from ${message.author.tag} in ${message.channel.id}`)
        this.batcher.add(message.channel.id, {
          author: message.author.displayName ?? message.author.username,
          authorId: message.author.id,
          content,
          timestamp: message.createdAt,
          message,
        })
        return
      }

      // Non-passive channels require a mention
      return
    }

    // Direct mention in a passive channel — flush any buffered messages
    // so they become part of the conversation history
    if (isPassive && this.batcher) {
      this.batcher.flushNow(message.channel.id)
    }

    // Get the message content (strip bot mention if present)
    const content = this.extractContent(message)
    if (!content.trim()) return

    // Enqueue to prevent concurrent access to shared AgentLoop context
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
      const task = this.messageQueue.shift()!
      try {
        await task()
      } catch (error) {
        log.error('discord', 'Queued message processing failed:', error)
      }
    }
    this.processing = false
  }

  private async processMessage(message: Message, content: string): Promise<void> {
    log.info('discord', `Message from ${message.author.tag}: ${content.slice(0, 100)}...`)

    const sessionKey = this.resolveSessionKey(message)
    const agent = this.getOrCreateAgent(sessionKey)

    // Keep typing indicator alive (Discord expires it after ~10s)
    const typingInterval = setInterval(() => {
      message.channel.sendTyping().catch(() => {})
    }, 8_000)

    try {
      // Show typing indicator immediately
      await message.channel.sendTyping()

      // Run through agent with event handler for tool transparency
      const { handler, state } = createDiscordEventHandler()
      const response = await agent.run(content, { events: handler })

      // Build response with tool call prefix
      const prefix = buildToolCallPrefix(state)
      const fullResponse = prefix + response.content

      // Send response (split if too long)
      await this.sendResponse(message, fullResponse)

      log.debug('discord', `[${sessionKey}] Responded via ${response.provider}${response.escalated ? ' (escalated)' : ''}`)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      log.error('discord', `Error processing message:`, error)
      await message.reply(`Sorry, I encountered an error: ${errorMsg}`).catch(() => {})
    } finally {
      clearInterval(typingInterval)
    }
  }

  private isUserAllowed(userId: string): boolean {
    // Empty allowedUsers = allow all
    if (this.config.allowedUsers.length === 0) return true
    return this.config.allowedUsers.includes(userId)
  }

  private isChannelAllowed(message: Message): boolean {
    const { allowedChannels } = this.config

    // Check for DM
    if (message.channel.type === ChannelType.DM) {
      return allowedChannels.includes('dm')
    }

    // Check specific channel ID
    if (allowedChannels.includes(message.channel.id)) return true

    // Check parent channel for threads
    if ('parentId' in message.channel && message.channel.parentId) {
      return allowedChannels.includes(message.channel.parentId)
    }

    return false
  }

  private isPassiveChannel(message: Message): boolean {
    const { passiveChannels } = this.config
    if (passiveChannels.length === 0) return false

    // DMs are never passive
    if (message.channel.type === ChannelType.DM) return false

    if (passiveChannels.includes(message.channel.id)) return true

    // Check parent channel for threads
    if ('parentId' in message.channel && message.channel.parentId) {
      return passiveChannels.includes(message.channel.parentId)
    }

    return false
  }

  /**
   * Called when the batcher's debounce timer fires for a passive channel.
   * Evaluates whether the bot should respond, and if so, sends the batch
   * through the agent loop.
   */
  private async handleBatch(channelId: string, messages: BufferedMessage[]): Promise<void> {
    if (!this.localProvider || messages.length === 0) return

    const botName = this.client.user?.displayName ?? this.client.user?.username ?? 'Kira'

    log.debug('discord', `Evaluating batch of ${messages.length} message(s) in channel ${channelId}`)

    const decision = await evaluateRelevance(this.localProvider, messages, botName)
    if (!decision.shouldRespond) {
      log.debug('discord', `Skipping batch in ${channelId}: ${decision.reason}`)
      return
    }

    log.info('discord', `Responding to batch in ${channelId}: ${decision.reason}`)

    // Use the last message in the batch as the reply target
    const lastMessage = messages[messages.length - 1]!.message
    const agentInput = formatBatchForAgent(messages)

    // Process through the normal agent pipeline
    this.enqueueMessage(() => this.processMessage(lastMessage, agentInput))
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

  private async sendResponse(message: Message, content: string): Promise<void> {
    // Discord message limit is 2000 characters
    const maxLength = 2000

    if (content.length <= maxLength) {
      await message.reply(content)
      return
    }

    // Split into chunks
    const chunks = splitMessage(content, maxLength)

    // Reply to first chunk
    await message.reply(chunks[0] ?? content.slice(0, maxLength))

    // Send remaining chunks as follow-up messages
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i]
      if (chunk) {
        await message.channel.send(chunk)
      }
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

  isReady(): boolean {
    return this.ready
  }
}

export function createDiscordChannel(agentFactory: AgentFactory, config: DiscordConfig, localProvider?: LLMProvider): DiscordChannel {
  return new DiscordChannel(agentFactory, config, localProvider)
}
