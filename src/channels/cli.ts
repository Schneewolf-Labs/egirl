import * as readline from 'readline'
import type { AgentLoop } from '../agent'
import type { ThinkingConfig } from '../providers/types'
import { handleCommand, SessionController } from '../session/controller'
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
import { createCLIEventHandler, renderQueuedMessage } from './cli-events'
import { captureDuringRun } from './cli-live-input'
import { contextBar, createStatusLine } from './cli-status'
import type { Channel } from './types'

export class CLIChannel implements Channel {
  readonly name = 'cli'
  private rl: readline.Interface | null = null
  private agent: AgentLoop
  private running = false
  private thinkingOverride: { current: ThinkingConfig | undefined } = { current: undefined }
  private showThinking: boolean
  /** Queue, abort handle and mutable settings -- everything that outlives a single turn. */
  private session = new SessionController()

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

    // stdin can end without anyone calling stop() — a piped command, a redirected file, or
    // Ctrl-D. Without this the reply loop calls question() again on a closed interface and
    // throws ERR_USE_AFTER_CLOSE, after the answer has already been printed. It makes the CLI
    // unusable for scripting, which is exactly how you would drive it from an eval harness.
    this.rl.on('close', () => {
      this.running = false
      this.rl = null
    })

    const c = colors()
    console.log(
      `\n${c.secondary}✦ egirl${RESET} ${DIM}— enter sends · esc interrupts · typing mid-turn queues · /exit quits${RESET}`,
    )
    console.log(
      `${DIM}  /think /plan /context /compact /wipe /prompt /debug /auto /maxturns /reasoning /queue /settings${RESET}\n`,
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
    const sessionCmd = handleCommand(input, this.session)
    if (sessionCmd.handled) {
      if (sessionCmd.quit) {
        this.rl?.close()
        return true
      }
      if (sessionCmd.message) console.log(`${colors().accent}${sessionCmd.message}${RESET}\n`)
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
    this.rl.question(`${c.primary}✦ you${RESET} `, async (input) => {
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

      let pending: string | undefined = trimmed
      while (pending !== undefined) {
        const signal = this.session.begin()
        // Escape aborts, and anything typed lands in the queue rather than in a buffer nobody
        // is reading. Torn down in `finally` so a thrown error cannot leave the terminal in raw
        // mode -- which makes it unusable until the window is closed.
        const keys = captureDuringRun(this.session, {
          onInterrupt: () => console.log(`\n${c.warning}interrupting…${RESET}`),
          onQueued: (text) => console.log(renderQueuedMessage(text)),
        })

        // 'waiting' rather than 'thinking': nothing has come back yet, so this is prefill,
        // which on a large context is minutes of genuine silence before the model even starts
        // reasoning. Calling that "thinking" would be a guess presented as fact.
        const status = createStatusLine()
        status.set('waiting')

        try {
          console.log()
          const { handler, state } = createCLIEventHandler(this.showThinking, status)
          const response = await this.agent.run(pending, {
            events: handler,
            thinking: this.thinkingOverride.current,
            maxTurns: this.session.get().maxTurns,
            signal,
          })

          if (this.session.wasInterrupted) {
            console.log(`\n${c.warning}stopped.${RESET}\n`)
          } else if (!state.streamed && response.content) {
            console.log(`\n${c.secondary}✦ egirl${RESET} ${response.content}\n`)
          }

          log.debug('cli', `[${response.provider}]`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`\n${c.error}Error:${RESET} ${message}\n`)
        } finally {
          status.stop()
          keys.stop()
          this.session.end()
        }

        // Printed every turn rather than on demand, because the moment context pressure
        // matters -- the turn before compaction discards the middle of the conversation -- is
        // exactly the moment nobody thinks to type /context.
        try {
          const ctx = await this.agent.contextStatus()
          console.log(
            `${DIM}context${RESET} ${contextBar(ctx.utilization, ctx.totalUsed, ctx.contextLength)}\n`,
          )
        } catch {
          // A status readout must never break a turn that already succeeded.
        }

        // Anything typed during the turn runs now rather than waiting for another return --
        // a queued message that sits unseen is worse than one that was never accepted.
        pending = this.session.drain()
        if (pending) console.log(`${c.primary}✦ you${RESET} ${pending}`)
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
