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
import type { AgentLoop } from '../agent'
import type { AgentEventHandler } from '../agent/events'
import type { ToolCall } from '../providers/types'
import type { ToolResult } from '../tools/types'
import { log } from '../util/logger'

export interface DiscordConfig {
  token: string
  allowedChannels: string[]  // Channel IDs or 'dm' for DMs
  allowedUsers: string[]     // User IDs (empty = allow all)
}

export interface ReactionEvent {
  emoji: string
  userId: string
  messageId: string
  isBot: boolean
}

export type ReactionHandler = (event: ReactionEvent) => void | Promise<void>
export type InteractionHandler = (interaction: Interaction) => void | Promise<void>

function formatToolCallsMarkdown(calls: ToolCall[]): string {
  const lines = calls.map(call => {
    const args = Object.entries(call.arguments)
    if (args.length === 0) return call.name + '()'
    if (args.length === 1) {
      const [key, val] = args[0]!
      const valStr = typeof val === 'string' ? val : JSON.stringify(val)
      if (valStr.length < 60) return `${call.name}(${key}: ${valStr})`
    }
    return `${call.name}(${JSON.stringify(call.arguments)})`
  })
  return lines.join('\n')
}

interface ToolCallEntry {
  call: string
  result?: string
}

interface DiscordEventState {
  entries: ToolCallEntry[]
}

function truncateResult(output: string, maxLen: number): string {
  const trimmed = output.trim()
  if (!trimmed) return ''
  if (trimmed.length <= maxLen) return trimmed
  return trimmed.substring(0, maxLen) + '...'
}

function createDiscordEventHandler(): { handler: AgentEventHandler; state: DiscordEventState } {
  const state: DiscordEventState = { entries: [] }
  let pendingCalls: ToolCall[] = []

  const handler: AgentEventHandler = {
    onToolCallStart(calls: ToolCall[]) {
      pendingCalls = calls
      for (const call of calls) {
        state.entries.push({ call: formatToolCallsMarkdown([call]) })
      }
    },

    onToolCallComplete(_callId: string, name: string, result: ToolResult) {
      // Find the matching entry and attach the result
      const entry = state.entries.find(e => e.call.startsWith(name) && !e.result)
      if (entry) {
        const status = result.success ? 'ok' : 'err'
        const preview = truncateResult(result.output, 150)
        entry.result = `  -> ${status}${preview ? ': ' + preview : ''}`
      }
    },
  }

  return { handler, state }
}

function buildToolCallPrefix(state: DiscordEventState): string {
  if (state.entries.length === 0) return ''
  const lines = state.entries.map(e => {
    if (e.result) return `${e.call}\n${e.result}`
    return e.call
  })
  return `\`\`\`\n${lines.join('\n')}\n\`\`\`\n`
}

export class DiscordChannel {
  private client: Client
  private agent: AgentLoop
  private config: DiscordConfig
  private ready = false
  private reactionHandlers: ReactionHandler[] = []
  private interactionHandlers: InteractionHandler[] = []

  constructor(agent: AgentLoop, config: DiscordConfig) {
    this.agent = agent
    this.config = config

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

  private async handleMessage(message: Message): Promise<void> {
    // Ignore bot messages (including our own)
    if (message.author.bot) return

    // Check if user is allowed
    if (!this.isUserAllowed(message.author.id)) {
      log.debug('discord', `Ignoring message from non-allowed user: ${message.author.tag}`)
      return
    }

    // Check if channel is allowed
    if (!this.isChannelAllowed(message)) {
      return
    }

    // For guild channels, only respond to mentions
    if (message.guild && !this.isMentioned(message)) {
      return
    }

    // Get the message content (strip bot mention if present)
    const content = this.extractContent(message)
    if (!content.trim()) return

    log.info('discord', `Message from ${message.author.tag}: ${content.slice(0, 100)}...`)

    try {
      // Show typing indicator
      await message.channel.sendTyping()

      // Run through agent with event handler for tool transparency
      const { handler, state } = createDiscordEventHandler()
      const response = await this.agent.run(content, { events: handler })

      // Build response with tool call prefix
      const prefix = buildToolCallPrefix(state)
      const fullResponse = prefix + response.content

      // Send response (split if too long)
      await this.sendResponse(message, fullResponse)

      log.debug('discord', `Responded via ${response.provider}${response.escalated ? ' (escalated)' : ''}`)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      log.error('discord', `Error processing message:`, error)
      await message.reply(`Sorry, I encountered an error: ${errorMsg}`).catch(() => {})
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
    return allowedChannels.includes(message.channel.id)
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
    const chunks = this.splitMessage(content, maxLength)

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

  private splitMessage(content: string, maxLength: number): string[] {
    const chunks: string[] = []
    let remaining = content

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining)
        break
      }

      // Try to split at a newline
      let splitIndex = remaining.lastIndexOf('\n', maxLength)
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        // Try to split at a space
        splitIndex = remaining.lastIndexOf(' ', maxLength)
      }
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        // Hard split
        splitIndex = maxLength
      }

      chunks.push(remaining.slice(0, splitIndex))
      remaining = remaining.slice(splitIndex).trimStart()
    }

    return chunks
  }

  async start(): Promise<void> {
    log.info('discord', 'Starting Discord bot...')
    await this.client.login(this.config.token)
  }

  async stop(): Promise<void> {
    log.info('discord', 'Stopping Discord bot...')
    this.client.destroy()
    this.ready = false
  }

  isReady(): boolean {
    return this.ready
  }
}

export function createDiscordChannel(agent: AgentLoop, config: DiscordConfig): DiscordChannel {
  return new DiscordChannel(agent, config)
}
