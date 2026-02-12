import {
  Client,
  GatewayIntentBits,
  Partials,
  Message,
  ChannelType,
  Events,
} from 'discord.js'
import type { AgentLoop } from '../agent'
import { log } from '../util/logger'

export interface DiscordConfig {
  token: string
  allowedChannels: string[]  // Channel IDs or 'dm' for DMs
  allowedUsers: string[]     // User IDs (empty = allow all)
}

export class DiscordChannel {
  private client: Client
  private agent: AgentLoop
  private config: DiscordConfig
  private ready = false

  constructor(agent: AgentLoop, config: DiscordConfig) {
    this.agent = agent
    this.config = config

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [
        Partials.Channel,  // Required for DMs
        Partials.Message,
      ],
    })

    this.setupEventHandlers()
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

    this.client.on(Events.Error, (error) => {
      log.error('discord', 'Client error:', error)
    })
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

      // Run through agent
      const response = await this.agent.run(content)

      // Send response (split if too long)
      await this.sendResponse(message, response.content)

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
