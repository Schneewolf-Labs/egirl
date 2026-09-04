/**
 * Slash commands, one vocabulary for every surface.
 *
 * `/think off` typed in a terminal, sent from a Matrix room, or posted by the console has to
 * mean one thing, so the parsing lives in one place and acts on the one object all of those
 * share: the session's AgentLoop. The terminal has state a chat channel does not (a queue, a
 * turn cap, a run mode); those commands take the SessionController and are refused, not
 * silently ignored, where there isn't one.
 */

import type { AgentLoop } from '../agent'
import type { ThinkingConfig } from '../providers/types'
import type { SessionController } from './controller'

/** A command and what it did, or why it did nothing. */
export interface CommandResult {
  handled: boolean
  message?: string
  quit?: boolean
}

export interface CommandScope {
  agent: AgentLoop
  /** Terminal-only state. Absent on a chat channel. */
  session?: SessionController
}

type ThinkingLevel = ThinkingConfig['level']
const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high']

// A word right after the slash. `/etc/hosts is wrong` is a sentence about a path, not a
// mistyped command, and goes to the model like any other text.
const COMMAND_SHAPE = /^\/[a-z]+(\s|$)/i

const TERMINAL_ONLY = 'only available in the terminal'

/** Parse a `/think` argument. `on` is a level, not a return to config: config may be off. */
function parseThinking(arg: string): ThinkingLevel | 'default' | undefined {
  const word = arg.toLowerCase()
  if (word === 'on') return 'medium'
  if (word === 'default') return 'default'
  return THINKING_LEVELS.find((l) => l === word)
}

function describeThinking(agent: AgentLoop): string {
  const { level, source } = agent.getThinking()
  return `${level} (${source})`
}

function thinkCommand(arg: string, agent: AgentLoop): CommandResult {
  if (!arg) {
    return {
      handled: true,
      message: `thinking: ${describeThinking(agent)}\nusage: /think <on|off|default>`,
    }
  }
  const level = parseThinking(arg)
  if (!level) return { handled: true, message: 'usage: /think <on|off|default>' }
  const before = describeThinking(agent)
  agent.setThinking(level === 'default' ? undefined : level)
  return { handled: true, message: `thinking: ${before} → ${describeThinking(agent)}` }
}

async function contextCommand(agent: AgentLoop): Promise<CommandResult> {
  const s = await agent.contextStatus()
  const pct = Math.round(s.utilization * 100)
  const lines = [
    `context: ${pct}% of ${s.contextLength.toLocaleString()} tokens`,
    `system prompt ~${s.systemPromptTokens.toLocaleString()}t · ${s.messageCount} messages ~${s.messageTokens.toLocaleString()}t`,
  ]
  if (s.hasSummary) lines.push(`summary ~${s.summaryTokens.toLocaleString()}t (compacted)`)
  lines.push(`available ~${s.available.toLocaleString()}t`)
  return { handled: true, message: lines.join('\n') }
}

function settingsCommand(scope: CommandScope): CommandResult {
  const parts = [`thinking ${describeThinking(scope.agent)}`]
  if (scope.session) {
    const s = scope.session.get()
    parts.push(
      `mode ${s.mode}`,
      `maxTurns ${s.maxTurns}`,
      `reasoning ${s.showReasoning ? 'on' : 'off'}`,
    )
  }
  return { handled: true, message: parts.join(' · ') }
}

function helpCommand(scope: CommandScope): CommandResult {
  const lines = [
    '/think <on|off|default> — thinking for this session',
    '/context — how full the window is',
    '/settings — current settings',
  ]
  if (scope.session) {
    lines.push(
      '/auto — toggle continuing past the turn cap without asking',
      '/maxturns <1-500> — turn cap for a run',
      '/reasoning — toggle showing reasoning inline',
      '/queue — messages waiting for the next turn',
      '/clear — drop queued messages',
      '/quit — exit',
    )
  }
  return { handled: true, message: lines.join('\n') }
}

/** Interpret a slash command. `handled: false` means the text is for the model. */
export async function handleCommand(input: string, scope: CommandScope): Promise<CommandResult> {
  if (!COMMAND_SHAPE.test(input)) return { handled: false }

  const [cmd, ...rest] = input.slice(1).trim().split(/\s+/)
  const arg = rest.join(' ')
  const { agent, session } = scope

  switch ((cmd ?? '').toLowerCase()) {
    case 'think':
      return thinkCommand(arg, agent)

    case 'context':
      return contextCommand(agent)

    case 'settings':
      return settingsCommand(scope)

    case 'help':
      return helpCommand(scope)

    case 'auto':
      if (!session) return { handled: true, message: `/auto is ${TERMINAL_ONLY}` }
      return { handled: true, message: session.toggleMode() }

    case 'maxturns': {
      if (!session) return { handled: true, message: `/maxturns is ${TERMINAL_ONLY}` }
      const n = Number(arg)
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        return { handled: true, message: 'usage: /maxturns <1-500>' }
      }
      return { handled: true, message: session.set('maxTurns', n) }
    }

    case 'reasoning':
      if (!session) return { handled: true, message: `/reasoning is ${TERMINAL_ONLY}` }
      return {
        handled: true,
        message: session.set('showReasoning', !session.get().showReasoning),
      }

    case 'queue': {
      if (!session) return { handled: true, message: `/queue is ${TERMINAL_ONLY}` }
      const q = session.peek()
      if (q.length === 0) return { handled: true, message: 'queue empty' }
      return { handled: true, message: q.map((m, i) => `  ${i + 1}. ${m.text}`).join('\n') }
    }

    case 'clear':
      if (!session) return { handled: true, message: `/clear is ${TERMINAL_ONLY}` }
      return { handled: true, message: `dropped ${session.clearQueue()} queued message(s)` }

    case 'quit':
    case 'exit':
      if (!session) return { handled: true, message: `/${cmd} is ${TERMINAL_ONLY}` }
      return { handled: true, quit: true }

    // Unknown slash input is reported rather than sent to the model: a mistyped command that
    // silently becomes a chat message is confusing in a way a plain error is not.
    default:
      return { handled: true, message: `unknown command: /${cmd} (try /help)` }
  }
}
