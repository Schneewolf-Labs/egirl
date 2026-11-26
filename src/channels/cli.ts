import { buildLearnPrompt } from '../agent/learn-prompt'
import type { ConfigDrift } from '../config/drift'
import type { Operator } from '../operator/types'
import { type CommandScope, customCommands, handleCommand, isCommand } from '../session/commands'
import { SessionController } from '../session/controller'
import type { Skill } from '../skills/types'
import type { TaskRunner, TaskStore } from '../tasks'
import { colors, DIM, RESET } from '../ui/theme'
import { errorMessage } from '../util/errors'
import { log } from '../util/logger'
import { type CommandContext, handleCLICommand } from './cli-commands'
import { CLI_COMMANDS, complete, menuItems } from './cli-complete'
import { renderDrained, renderQueuedMessage } from './cli-events'
import { appendHistory, loadHistory } from './cli-history'
import { type CLIInput, createCLIInput } from './cli-input'
import { tasksCommand } from './cli-tasks'
import { themeCommand } from './cli-theme'
import { runTurns } from './cli-turn'
import { createWaitHistory } from './cli-wait'
import type { Channel } from './types'

export interface CLIChannelOptions {
  showThinking?: boolean
  skillsDir?: string
  /** `[conversation] max_turns`: the session's starting turn cap. */
  maxTurns?: number
  /** The tasks.db this process has open, for /tasks. Absent when tasks are off. */
  taskStore?: TaskStore
  /** Loaded skills, for the slash commands they declare (`egirl.command` in SKILL.md). */
  skills?: Skill[]
  /** The config files as read at startup, so /settings can say when they changed since. */
  configDrift?: ConfigDrift
  /** Where ↑ history is saved between runs; absent keeps it for this run only. */
  historyPath?: string
}

const EXIT_WORDS = new Set(['/exit', '/quit', 'exit', 'quit'])

export class CLIChannel implements Channel {
  readonly name = 'cli'
  private input: CLIInput | undefined
  private agent: Operator
  /** Queue, abort handle and mutable settings -- everything that outlives a single turn. */
  private session: SessionController
  /** Target directory for /learn-authored skills; undefined disables the command. */
  private skillsDir: string | undefined
  /** A command or turn is in progress; lines typed now are queued or answered alongside. */
  private busy = false
  /** Piped input only: lines read ahead of the turn, each run as its own turn in order. */
  private backlog: string[] = []
  private waits = createWaitHistory()
  private taskStore: TaskStore | undefined
  private skills: Skill[]
  /** Set once the background runner is up (it is built after the channel it reports to). */
  private taskRunner: TaskRunner | undefined
  private historyPath: string | undefined
  private configDrift: ConfigDrift | undefined

  constructor(agent: Operator, options?: CLIChannelOptions) {
    this.agent = agent
    // The configured cap is the starting point; /maxturns changes it for this session only.
    // The configured cap and reasoning display are the starting point; /maxturns and
    // /reasoning change them for this session only.
    this.session = new SessionController({
      ...(options?.maxTurns !== undefined && { maxTurns: options.maxTurns }),
      showReasoning: options?.showThinking ?? true,
    })
    this.skillsDir = options?.skillsDir
    this.taskStore = options?.taskStore
    this.skills = options?.skills ?? []
    this.historyPath = options?.historyPath
    this.configDrift = options?.configDrift
  }

  useTaskRunner(runner: TaskRunner): void {
    this.taskRunner = runner
  }

  /** `/tasks …`, answered the same at the prompt and mid-turn. Undefined: not that command. */
  private tasks(input: string): string | undefined {
    if (input !== '/tasks' && !input.startsWith('/tasks ')) return undefined
    if (!this.taskStore) return `${DIM}tasks are off in this process${RESET}`
    return tasksCommand(input.slice('/tasks'.length), {
      store: this.taskStore,
      ...(this.taskRunner && { runner: this.taskRunner }),
      notify: (text) => (this.input ? this.input.notice(text) : console.log(text)),
    })
  }

  /** Outbound: print a background task result to stdout */
  async send(_target: string, message: string): Promise<void> {
    const c = colors()
    process.stdout.write(`\n${c.accent}[background]${RESET} ${message}\n\n`)
  }

  async start(): Promise<void> {
    const c = colors()
    console.log(
      `\n${c.secondary}✦ egirl${RESET} ${DIM}— enter sends · esc interrupts · typing mid-turn queues · /exit quits${RESET}`,
    )
    console.log(
      `${DIM}  ${CLI_COMMANDS.map((s) => `/${s.name}`).join(' ')} · tab completes · ctrl-r searches history${RESET}\n`,
    )
    this.input = createCLIInput({
      onLine: (line) => this.onLine(line),
      onEscape: () => {
        if (this.session.interrupt()) this.input?.notice(`${c.warning}interrupting…${RESET}`)
      },
      // stdin can end without anyone calling stop() — a piped command, a redirected file, or
      // Ctrl-D. Whatever was already read still runs; nothing new is asked for.
      onClose: () => {
        this.input = undefined
      },
      complete: (line) =>
        complete(
          line,
          () => this.taskStore?.list().map((t) => t.name) ?? [],
          () => customCommands(this.skills).map((c) => c.name),
        ),
      menu: (prefix) => menuItems(prefix, () => customCommands(this.skills)),
      ...(this.historyPath && { history: loadHistory(this.historyPath) }),
    })
    this.idle()
  }

  async stop(): Promise<void> {
    this.input?.close()
    this.input = undefined
  }

  private idle(): void {
    this.input?.setPrompt(`${colors().primary}✦ you${RESET} `)
  }

  private onLine(line: string): void {
    const text = line.trim()
    if (!text) return
    if (this.historyPath && this.input?.isInteractive) appendHistory(this.historyPath, text)
    if (!this.busy) {
      // The live line is cleared on enter; this leaves what was sent in the scrollback.
      if (this.input?.isInteractive) console.log(`${colors().primary}✦ you${RESET} ${text}`)
      void this.work(text)
      return
    }
    if (!this.input?.isInteractive) {
      this.backlog.push(text)
      return
    }
    if (isCommand(text) && !EXIT_WORDS.has(text)) {
      this.commandMidTurn(text)
      return
    }
    this.session.enqueue(text)
    this.input.notice(renderQueuedMessage(text))
  }

  /** A slash command typed mid-turn is answered now; one that is a turn waits its turn. */
  private commandMidTurn(text: string): void {
    const c = colors()
    const tasks = this.tasks(text)
    if (tasks !== undefined) {
      this.input?.notice(tasks)
      return
    }
    const word = text.split(/\s+/)[0] ?? ''
    // Read-only terminal commands answer at once; the ones that change the session or start a
    // run of their own would collide with the turn in flight, so they say so instead of
    // falling through to "unknown command".
    if (word === '/theme') {
      this.input?.notice(themeCommand(text.slice('/theme'.length)))
      return
    }
    if (word === '/prompt' || word === '/debug') {
      void handleCLICommand(word, this.commandCtx())
      return
    }
    if (['/compact', '/wipe', '/plan', '/learn'].includes(word)) {
      this.input?.notice(
        `${c.warning}${word} can't run during a turn${RESET} ${DIM}— run it when this one ends, or press esc to stop it${RESET}`,
      )
      return
    }
    handleCommand(text, this.commandScope())
      .then((r) => {
        if (r.turn) {
          this.session.enqueue(r.turn)
          this.input?.notice(renderQueuedMessage(text))
        }
        if (r.message) this.input?.notice(`${c.accent}${r.message}${RESET}`)
      })
      .catch((error) => log.warn('cli', `command failed: ${errorMessage(error)}`))
  }

  private commandScope(): CommandScope {
    return {
      agent: this.agent,
      session: this.session,
      skills: this.skills,
      ...(this.configDrift && { configDrift: this.configDrift }),
    }
  }

  private commandCtx(): CommandContext {
    return {
      agent: this.agent,
      showThinking: this.session.get().showReasoning,
      askApproval: () => this.askApproval(),
    }
  }

  /** True: handled. A string: a command that expands into a turn (/continue). */
  private async handleCommand(input: string): Promise<boolean | string> {
    const tasks = this.tasks(input)
    if (tasks !== undefined) {
      console.log(`${tasks}\n`)
      return true
    }
    if (await handleCLICommand(input, this.commandCtx())) return true
    // /learn is a turn, not a command: the caller rewrites it and runs it.
    if (input === '/learn' || input.startsWith('/learn ')) return false
    const shared = await handleCommand(input, this.commandScope())
    if (!shared.handled) return false
    if (shared.quit) await this.quit()
    if (shared.turn) return shared.turn
    if (shared.message) console.log(`${colors().accent}${shared.message}${RESET}\n`)
    return true
  }

  private async quit(): Promise<never> {
    console.log('Goodbye!')
    await this.stop()
    process.exit(0)
  }

  /** Run what was typed at the prompt -- a command, a turn, or both -- then whatever queued. */
  private async work(text: string): Promise<void> {
    this.busy = true
    this.input?.setPrompt(`${colors().secondary}♡${RESET} `)
    try {
      if (EXIT_WORDS.has(text.toLowerCase())) await this.quit()
      let pending = await this.toTurn(text)
      // A command can take a while (/plan, /compact); anything typed meanwhile goes next.
      if (pending === undefined) {
        const queued = this.session.peek().length
        pending = this.session.drain()
        if (pending) console.log(renderDrained(pending, queued))
      }
      if (pending !== undefined) {
        await runTurns(pending, {
          agent: this.agent,
          session: this.session,
          input: this.input,
          waits: this.waits,
        })
      }
    } catch (error) {
      console.error(`\n${colors().error}Error:${RESET} ${errorMessage(error)}\n`)
    } finally {
      this.busy = false
      this.idle()
    }
    const next = this.backlog.shift()
    if (next !== undefined) void this.work(next)
  }

  /** What `text` sends to the model, or undefined when it was a command that answered itself. */
  private async toTurn(text: string): Promise<string | undefined> {
    const command = await this.handleCommand(text)
    if (command === true) return undefined
    if (typeof command === 'string') return command
    // /learn rewrites the input and then runs as an ordinary turn -- the agent does the
    // distillation with its own tools, so interrupt/queue/status behave as in any turn.
    if (text === '/learn' || text.startsWith('/learn ')) {
      if (!this.skillsDir) {
        console.log(
          `${DIM}No skills directory configured — add [skills] dirs to egirl.toml.${RESET}\n`,
        )
        return undefined
      }
      return buildLearnPrompt(text.slice('/learn'.length), this.skillsDir)
    }
    return text
  }

  private async askApproval(): Promise<boolean> {
    if (!this.input) return false
    const c = colors()
    const answer = await this.input.ask(
      `${c.warning}Execute this plan?${RESET} ${DIM}(y/n)${RESET} `,
    )
    const lower = answer.trim().toLowerCase()
    return lower === 'y' || lower === 'yes'
  }
}

export function createCLIChannel(agent: Operator, options?: CLIChannelOptions): CLIChannel {
  return new CLIChannel(agent, options)
}
