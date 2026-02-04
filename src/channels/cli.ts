import * as readline from 'readline'
import type { Channel, ChannelMessage, ChannelResponse } from './types'

export class CLIChannel implements Channel {
  name = 'cli'
  private rl: readline.Interface | null = null
  private handler: ((message: ChannelMessage) => Promise<ChannelResponse>) | null = null
  private running = false

  async start(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    this.running = true

    console.log('\negirl CLI - Type your message and press Enter. Type "exit" to quit.\n')

    this.prompt()
  }

  async stop(): Promise<void> {
    this.running = false
    this.rl?.close()
    this.rl = null
  }

  onMessage(handler: (message: ChannelMessage) => Promise<ChannelResponse>): void {
    this.handler = handler
  }

  private prompt(): void {
    if (!this.running || !this.rl) return

    this.rl.question('you> ', async (input) => {
      if (!this.running) return

      const trimmed = input.trim()

      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        console.log('Goodbye!')
        await this.stop()
        process.exit(0)
        return
      }

      if (trimmed.toLowerCase() === 'clear') {
        console.clear()
        this.prompt()
        return
      }

      if (!trimmed) {
        this.prompt()
        return
      }

      if (this.handler) {
        const message: ChannelMessage = {
          id: crypto.randomUUID(),
          content: trimmed,
          userId: 'cli-user',
          userName: 'User',
          channelId: 'cli',
          timestamp: new Date(),
        }

        try {
          console.log()  // Blank line before response
          const response = await this.handler(message)
          console.log(`\negirl> ${response.content}\n`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`\nError: ${message}\n`)
        }
      }

      this.prompt()
    })
  }
}

export function createCLIChannel(): Channel {
  return new CLIChannel()
}
