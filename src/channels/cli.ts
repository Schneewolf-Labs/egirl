import * as readline from 'readline'
import type { AgentLoop } from '../agent'
import { log } from '../util/logger'

export class CLIChannel {
  private rl: readline.Interface | null = null
  private agent: AgentLoop
  private running = false

  constructor(agent: AgentLoop) {
    this.agent = agent
  }

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

      try {
        console.log()
        const response = await this.agent.run(trimmed)

        // Show routing info
        const routingInfo = response.escalated
          ? `[escalated to ${response.provider}]`
          : `[${response.provider}]`

        log.debug('cli', routingInfo)
        console.log(`\negirl> ${response.content}\n`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`\nError: ${message}\n`)
      }

      this.prompt()
    })
  }
}

export function createCLIChannel(agent: AgentLoop): CLIChannel {
  return new CLIChannel(agent)
}
