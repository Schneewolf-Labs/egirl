import * as readline from 'readline'
import type { AgentLoop } from '../agent'
import type { AgentEventHandler } from '../agent/events'
import type { ThinkingConfig, ToolCall } from '../providers/types'
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
    const entry = entries[0]
    if (!entry) return ''
    const [key, val] = entry
    const valStr = typeof val === 'string' ? val : JSON.stringify(val)
    // Short single-arg: show inline
    if (valStr.length < 60) return `${key}: ${valStr}`
  }
  return JSON.stringify(args, null, 2)
}

interface CLIEventState {
  streamed: boolean
  showThinking: boolean
}

function createCLIEventHandler(showThinking: boolean): {
  handler: AgentEventHandler
  state: CLIEventState
} {
  const state: CLIEventState = { streamed: false, showThinking }

  const handler: AgentEventHandler = {
    onThinking(text: string) {
      if (!state.showThinking) return
      if (text.trim()) {
        const c = colors()
        // Truncate long thinking output for display
        const lines = text.trim().split('\n')
        const maxLines = 20
        const display =
          lines.length > maxLines
            ? [...lines.slice(0, maxLines), `  ... (${lines.length - maxLines} more lines)`].join(
                '\n',
              )
            : text.trim()
        process.stdout.write(`${DIM}${c.info}[thinking]${RESET}${DIM}\n${display}${RESET}\n`)
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

const THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const

export class CLIChannel implements Channel {
  readonly name = 'cli'
  private rl: readline.Interface | null = null
  private agent: AgentLoop
  private running = false
  private thinkingOverride: ThinkingConfig | undefined
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
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    this.running = true

    const c = colors()
    console.log(
      `\n${c.primary}egirl CLI${RESET} ${DIM}— Type your message and press Enter. Type "exit" to quit.${RESET}`,
    )
    console.log(
      `${DIM}Commands: /think <off|low|medium|high>, /plan <message>, /context, /compact, clear, exit${RESET}\n`,
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

      // Handle /think command
      if (trimmed.startsWith('/think')) {
        this.handleThinkCommand(trimmed)
        this.prompt()
        return
      }

      // Handle /plan command
      if (trimmed.startsWith('/plan')) {
        const message = trimmed.slice(5).trim()
        if (!message) {
          console.log(`${DIM}Usage: /plan <your request>${RESET}\n`)
          this.prompt()
          return
        }
        await this.handlePlanCommand(message)
        this.prompt()
        return
      }

      // Handle /context command
      if (trimmed === '/context') {
        await this.handleContextCommand()
        this.prompt()
        return
      }

      // Handle /compact command
      if (trimmed === '/compact') {
        await this.handleCompactCommand()
        this.prompt()
        return
      }

      try {
        console.log()
        const { handler, state } = createCLIEventHandler(this.showThinking)
        const response = await this.agent.run(trimmed, {
          events: handler,
          thinking: this.thinkingOverride,
        })

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

  private handleThinkCommand(input: string): void {
    const c = colors()
    const parts = input.split(/\s+/)
    const level = parts[1]?.toLowerCase()

    if (!level) {
      const current = this.thinkingOverride?.level ?? 'config default'
      console.log(`\n${c.info}Thinking level:${RESET} ${current}`)
      console.log(`${DIM}Usage: /think <off|low|medium|high>${RESET}\n`)
      return
    }

    if (!THINKING_LEVELS.includes(level as (typeof THINKING_LEVELS)[number])) {
      console.log(`\n${c.error}Invalid thinking level:${RESET} ${level}`)
      console.log(`${DIM}Valid levels: off, low, medium, high${RESET}\n`)
      return
    }

    const thinkingLevel = level as ThinkingConfig['level']

    if (thinkingLevel === 'off') {
      this.thinkingOverride = { level: 'off' }
      console.log(`\n${c.muted}Thinking disabled${RESET}\n`)
    } else {
      this.thinkingOverride = { level: thinkingLevel }
      console.log(`\n${c.success}Thinking level set to ${thinkingLevel}${RESET}\n`)
    }
  }

  private async handlePlanCommand(message: string): Promise<void> {
    const c = colors()

    try {
      console.log()
      const { handler, state } = createCLIEventHandler(this.showThinking)
      const response = await this.agent.run(message, {
        events: handler,
        thinking: this.thinkingOverride,
        planningMode: true,
      })

      if (!state.streamed && response.content) {
        console.log(`\n${c.secondary}egirl>${RESET} ${response.content}\n`)
      }

      if (!response.isPlan) return

      // Prompt for plan approval
      const approved = await this.askApproval()

      if (approved) {
        console.log(`\n${c.success}Plan approved.${RESET} Executing...\n`)

        const { handler: execHandler, state: execState } = createCLIEventHandler(this.showThinking)
        const execResponse = await this.agent.run(
          'Approved. Execute the plan above step by step.',
          {
            events: execHandler,
            thinking: this.thinkingOverride,
            maxTurns: 20,
          },
        )

        if (!execState.streamed && execResponse.content) {
          console.log(`\n${c.secondary}egirl>${RESET} ${execResponse.content}\n`)
        }
      } else {
        console.log(
          `\n${c.warning}Plan rejected.${RESET} You can modify your request and try again.\n`,
        )
        // Add a note to context so the agent knows the plan was rejected
        this.agent
          .run('[User rejected the plan. Awaiting new instructions.]', {
            maxTurns: 1,
          })
          .catch(() => {
            // Swallow — this is just to add context
          })
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`\n${c.error}Error:${RESET} ${errorMessage}\n`)
    }
  }

  private async handleContextCommand(): Promise<void> {
    const c = colors()
    try {
      const status = await this.agent.contextStatus()
      const pct = Math.round(status.utilization * 100)

      // Color the utilization bar based on how full the context is
      let barColor = c.success
      if (pct > 80) barColor = c.error
      else if (pct > 60) barColor = c.warning

      const barWidth = 30
      const filled = Math.round((pct / 100) * barWidth)
      const bar = `${barColor}${'█'.repeat(filled)}${DIM}${'░'.repeat(barWidth - filled)}${RESET}`

      console.log(`\n${c.primary}Context Window${RESET}`)
      console.log(`  ${bar} ${barColor}${pct}%${RESET}`)
      console.log(`${DIM}  Session:        ${status.sessionId}${RESET}`)
      console.log(`${DIM}  Budget:         ${status.contextLength.toLocaleString()} tokens${RESET}`)
      console.log(`${DIM}  System prompt:  ~${status.systemPromptTokens.toLocaleString()}t${RESET}`)
      console.log(
        `${DIM}  Messages:       ${status.messageCount} (~${status.messageTokens.toLocaleString()}t)${RESET}`,
      )
      if (status.hasSummary) {
        console.log(
          `${DIM}  Summary:        ~${status.summaryTokens.toLocaleString()}t (compacted)${RESET}`,
        )
      }
      console.log(`${DIM}  Available:      ~${status.available.toLocaleString()}t${RESET}`)
      console.log()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`${c.error}Failed to get context status:${RESET} ${msg}\n`)
    }
  }

  private async handleCompactCommand(): Promise<void> {
    const c = colors()
    try {
      const result = await this.agent.compactNow()
      if (result.messagesBefore === result.messagesAfter) {
        console.log(`\n${c.muted}Nothing to compact (${result.messagesBefore} messages).${RESET}\n`)
      } else {
        const dropped = result.messagesBefore - result.messagesAfter
        console.log(
          `\n${c.success}Compacted:${RESET} ${dropped} messages summarized, ${result.messagesAfter} kept.\n`,
        )
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`${c.error}Compaction failed:${RESET} ${msg}\n`)
    }
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
