import * as readline from 'readline'
import type { AgentLoop } from '../agent'
import type { ThinkingConfig } from '../providers/types'
import { colors, DIM, RESET } from '../ui/theme'
import { log } from '../util/logger'
import {
  type CommandContext,
  handleCompactCommand,
  handleContextCommand,
  handleDebugCommand,
  handlePlanCommand,
  handlePromptCommand,
  handleThinkCommand,
  handleWipeCommand,
} from './cli-commands'
import { createCLIEventHandler } from './cli-events'
import type { Channel } from './types'

export class CLIChannel implements Channel {
  readonly name = 'cli'
  private rl: readline.Interface | null = null
  private agent: AgentLoop
  private running = false
  private thinkingOverride: { current: ThinkingConfig | undefined } = { current: undefined }
  private showThinking: boolean

  constructor(agent: AgentLoop, options?: { showThinking?: boolean }) {
    this.agent = agent
    this.showThinking = options?.showThinking ?? true
  }

  /** Outbound: print a background task result to stdout */
  async send(_target: string, message: string): Promise<void> {
    const c = colors()
    process.stdout.write(`\n${c.accent}[background]${RESET} ${message}\n\n`)
  }

  async start(): Promise<void> {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    this.running = true

    const c = colors()
    console.log(
      `\n${c.primary}egirl CLI${RESET} ${DIM}— Type your message and press Enter. Type "/exit" to quit.${RESET}`,
    )
    console.log(
      `${DIM}Commands: /think <off|low|medium|high>, /plan <message>, /context, /compact, /wipe, /prompt, /debug, /clear, /exit${RESET}\n`,
    )

    this.prompt()
  }

  async stop(): Promise<void> {
    this.running = false
    this.rl?.close()
    this.rl = null
  }

  private commandCtx(): CommandContext {
    return {
      agent: this.agent,
      showThinking: this.showThinking,
      thinkingOverride: this.thinkingOverride,
      askApproval: () => this.askApproval(),
    }
  }

  private async handleCommand(input: string): Promise<boolean> {
    if (input === '/clear' || input.toLowerCase() === 'clear') {
      console.clear()
      return true
    }
    if (input.startsWith('/think')) {
      handleThinkCommand(input, this.commandCtx())
      return true
    }
    if (input.startsWith('/plan')) {
      const message = input.slice(5).trim()
      if (!message) {
        console.log(`${DIM}Usage: /plan <your request>${RESET}\n`)
      } else {
        await handlePlanCommand(message, this.commandCtx())
      }
      return true
    }
    if (input === '/context') {
      await handleContextCommand(this.commandCtx())
      return true
    }
    if (input === '/compact') {
      await handleCompactCommand(this.commandCtx())
      return true
    }
    if (input === '/wipe') {
      handleWipeCommand(this.commandCtx())
      return true
    }
    if (input === '/prompt') {
      handlePromptCommand(this.commandCtx())
      return true
    }
    if (input === '/debug') {
      handleDebugCommand(this.commandCtx())
      return true
    }
    return false
  }

  private prompt(): void {
    if (!this.running || !this.rl) return

    const c = colors()
    this.rl.question(`${c.primary}you>${RESET} `, async (input) => {
      if (!this.running) return

      const trimmed = input.trim()

      if (
        trimmed === '/exit' ||
        trimmed === '/quit' ||
        trimmed.toLowerCase() === 'exit' ||
        trimmed.toLowerCase() === 'quit'
      ) {
        console.log('Goodbye!')
        await this.stop()
        process.exit(0)
        return
      }

      if (!trimmed) {
        this.prompt()
        return
      }

      if (await this.handleCommand(trimmed)) {
        this.prompt()
        return
      }

      try {
        console.log()
        const { handler, state } = createCLIEventHandler(this.showThinking)
        const response = await this.agent.run(trimmed, {
          events: handler,
          thinking: this.thinkingOverride.current,
        })

        if (!state.streamed && response.content) {
          console.log(`\n${c.secondary}egirl>${RESET} ${response.content}\n`)
        }

        log.debug('cli', `[${response.provider}]`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`\n${c.error}Error:${RESET} ${message}\n`)
      }

      this.prompt()
    })
  }

  private askApproval(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.rl) {
        resolve(false)
        return
      }
      const c = colors()
      this.rl.question(`${c.warning}Execute this plan?${RESET} ${DIM}(y/n)${RESET} `, (answer) => {
        const lower = answer.trim().toLowerCase()
        resolve(lower === 'y' || lower === 'yes')
      })
    })
  }
}

export function createCLIChannel(
  agent: AgentLoop,
  options?: { showThinking?: boolean },
): CLIChannel {
  return new CLIChannel(agent, options)
}
