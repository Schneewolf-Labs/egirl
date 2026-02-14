import * as readline from 'readline'
import type { AgentLoop } from '../agent'
import type { AgentEventHandler } from '../agent/events'
import type { ToolCall } from '../providers/types'
import type { ToolResult } from '../tools/types'
import { colors, DIM, RESET } from '../ui/theme'
import { log } from '../util/logger'
import type { Channel } from './types'

function truncateResult(output: string, maxLen: number): string {
  const trimmed = output.trim()
  if (!trimmed) return ''
  if (trimmed.length <= maxLen) return trimmed
  return `${trimmed.substring(0, maxLen)}...`
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
  if (entries.length === 0) return ''
  if (entries.length === 1) {
    const [key, val] = entries[0]!
    const valStr = typeof val === 'string' ? val : JSON.stringify(val)
    // Short single-arg: show inline
    if (valStr.length < 60) return `${key}: ${valStr}`
  }
  return JSON.stringify(args, null, 2)
}

interface CLIEventState {
  streamed: boolean
}

function createCLIEventHandler(): { handler: AgentEventHandler; state: CLIEventState } {
  const state: CLIEventState = { streamed: false }

  const handler: AgentEventHandler = {
    onThinking(text: string) {
      if (text.trim()) {
        process.stdout.write(`${DIM}${text.trim()}${RESET}\n`)
      }
    },

    onToolCallStart(calls: ToolCall[]) {
      const c = colors()
      for (const call of calls) {
        const args = formatArgs(call.arguments)
        if (args.includes('\n')) {
          process.stdout.write(
            `${DIM}  ${c.accent}>${RESET}${DIM} ${call.name}(\n${args}\n  )${RESET}\n`,
          )
        } else {
          process.stdout.write(`${DIM}  ${c.accent}>${RESET}${DIM} ${call.name}(${args})${RESET}\n`)
        }
      }
    },

    onToolCallComplete(_callId: string, name: string, result: ToolResult) {
      const c = colors()
      const status = result.success ? `${c.success}ok${RESET}` : `${c.error}err${RESET}`
      const preview = truncateResult(result.output, 200)
      process.stdout.write(`${DIM}  < ${name} ${status}${RESET}\n`)
      if (preview) {
        for (const line of preview.split('\n')) {
          process.stdout.write(`${DIM}    ${line}${RESET}\n`)
        }
      }
    },

    onToken(token: string) {
      if (!state.streamed) {
        const c = colors()
        process.stdout.write(`\n${c.secondary}egirl>${RESET} `)
        state.streamed = true
      }
      process.stdout.write(token)
    },

    onResponseComplete() {
      if (state.streamed) {
        process.stdout.write('\n\n')
      }
    },
  }

  return { handler, state }
}

export class CLIChannel implements Channel {
  readonly name = 'cli'
  private rl: readline.Interface | null = null
  private agent: AgentLoop
  private running = false

  constructor(agent: AgentLoop) {
    this.agent = agent
  }

  /** Outbound: print a background task result to stdout */
  async send(_target: string, message: string): Promise<void> {
    const c = colors()
    process.stdout.write(`\n${c.accent}[background]${RESET} ${message}\n\n`)
  }

  async start(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    this.running = true

    const c = colors()
    console.log(
      `\n${c.primary}egirl CLI${RESET} ${DIM}— Type your message and press Enter. Type "exit" to quit.${RESET}\n`,
    )

    this.prompt()
  }

  async stop(): Promise<void> {
    this.running = false
    this.rl?.close()
    this.rl = null
  }

  private prompt(): void {
    if (!this.running || !this.rl) return

    const c = colors()
    this.rl.question(`${c.primary}you>${RESET} `, async (input) => {
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
        const { handler, state } = createCLIEventHandler()
        const response = await this.agent.run(trimmed, { events: handler })

        // If streaming didn't happen, print the response directly
        if (!state.streamed && response.content) {
          console.log(`\n${c.secondary}egirl>${RESET} ${response.content}\n`)
        }

        // Show routing info
        const routingInfo = response.escalated
          ? `[escalated to ${response.provider}]`
          : `[${response.provider}]`

        log.debug('cli', routingInfo)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`\n${c.error}Error:${RESET} ${message}\n`)
      }

      this.prompt()
    })
  }
}

export function createCLIChannel(agent: AgentLoop): CLIChannel {
  return new CLIChannel(agent)
}
