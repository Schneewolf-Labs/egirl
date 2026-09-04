/**
 * Slash commands, one vocabulary for every surface.
 *
 * `/think off` typed in a terminal, sent from a Matrix room, or posted by the console has to
 * mean one thing, so the parsing lives in one place and acts on the one object all of those
 * share: the session's AgentLoop. The terminal has state a chat channel does not (a queue, a
 * turn cap, a run mode); those commands take the SessionController and are refused, not
 * silently ignored, where there isn't one.
 *
 * None of this touches the model. A command answers at once, including while a turn is
 * running -- that is what makes /status a way to ping the harness rather than the LLM.
 * Replies are plain text with an emoji lead so they read the same on a terminal, in a
 * Matrix body and in a Discord message.
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

/** Whether the text is a slash command -- so a channel can answer it ahead of its turn queue. */
export function isCommand(text: string): boolean {
  return COMMAND_SHAPE.test(text)
}

const THINK_USAGE = 'usage: /think <on|off|default>'

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

function reply(message: string): CommandResult {
  return { handled: true, message }
}

function terminalOnly(cmd: string): CommandResult {
  return reply(`🖥️ /${cmd} is only available in the terminal`)
}

function thinkCommand(arg: string, agent: AgentLoop): CommandResult {
  if (!arg) return reply(`🧠 thinking: ${describeThinking(agent)}\n${THINK_USAGE}`)
  const level = parseThinking(arg)
  if (!level) return reply(`🧠 ${THINK_USAGE}`)
  const before = describeThinking(agent)
  agent.setThinking(level === 'default' ? undefined : level)
  return reply(`🧠 thinking: ${before} → ${describeThinking(agent)}`)
}

/** A ten-cell text bar; renders the same in every font, which a Unicode block gauge does not. */
function bar(fraction: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * 10)
  return '▓'.repeat(filled) + '░'.repeat(10 - filled)
}

const t = (n: number) => `${n.toLocaleString()}t`

async function contextCommand(agent: AgentLoop): Promise<CommandResult> {
  const s = await agent.contextStatus()
  const pct = Math.round(s.utilization * 100)
  const lines = [
    `📊 context ${pct}% ${bar(s.utilization)} ${s.totalUsed.toLocaleString()} / ${s.contextLength.toLocaleString()}`,
    `system prompt ~${t(s.systemPromptTokens)} · ${s.messageCount} messages ~${t(s.messageTokens)}`,
  ]
  if (s.hasSummary) lines.push(`summary ~${t(s.summaryTokens)} (compacted)`)
  lines.push(`available ~${t(s.available)}`)
  return reply(lines.join('\n'))
}

/** The harness at a glance: is she busy, and where does this session stand. */
async function statusCommand(agent: AgentLoop): Promise<CommandResult> {
  const s = await agent.contextStatus()
  const state = agent.isRunning() ? '⏳ running' : '🟢 idle'
  return reply(
    `${state} · ${s.sessionId} · context ${Math.round(s.utilization * 100)}% · thinking ${describeThinking(agent)}`,
  )
}

function settingsCommand(scope: CommandScope): CommandResult {
  const parts = [`🧠 thinking ${describeThinking(scope.agent)}`]
  if (scope.session) {
    const s = scope.session.get()
    parts.push(
      `🔁 mode ${s.mode}`,
      `🔢 maxTurns ${s.maxTurns}`,
      `💭 reasoning ${s.showReasoning ? 'on' : 'off'}`,
    )
  }
  return reply(parts.join(' · '))
}

function helpCommand(scope: CommandScope): CommandResult {
  const lines = [
    '🧠 /think <on|off|default> — thinking for this session',
    '🟢 /status — busy or idle, context, thinking',
    '📊 /context — how full the window is',
    '⚙️ /settings — current settings',
  ]
  if (scope.session) {
    lines.push(
      '🔁 /auto — continue past the turn cap without asking',
      '🔢 /maxturns <1-500> — turn cap for a run',
      '💭 /reasoning — show reasoning inline',
      '📥 /queue — messages waiting for the next turn',
      '🧹 /clear — drop queued messages',
      '👋 /quit — exit',
    )
  }
  return reply(lines.join('\n'))
}

/** Interpret a slash command. `handled: false` means the text is for the model. */
export async function handleCommand(input: string, scope: CommandScope): Promise<CommandResult> {
  if (!isCommand(input)) return { handled: false }

  const [word, ...rest] = input.slice(1).trim().split(/\s+/)
  const cmd = (word ?? '').toLowerCase()
  const arg = rest.join(' ')
  const { agent, session } = scope

  switch (cmd) {
    case 'think':
      return thinkCommand(arg, agent)

    case 'status':
      return statusCommand(agent)

    case 'context':
      return contextCommand(agent)

    case 'settings':
      return settingsCommand(scope)

    case 'help':
      return helpCommand(scope)

    case 'auto':
      if (!session) return terminalOnly(cmd)
      return reply(`🔁 ${session.toggleMode()}`)

    case 'maxturns': {
      if (!session) return terminalOnly(cmd)
      const n = Number(arg)
      if (!Number.isInteger(n) || n < 1 || n > 500) return reply('🔢 usage: /maxturns <1-500>')
      return reply(`🔢 ${session.set('maxTurns', n)}`)
    }

    case 'reasoning':
      if (!session) return terminalOnly(cmd)
      return reply(`💭 ${session.set('showReasoning', !session.get().showReasoning)}`)

    case 'queue': {
      if (!session) return terminalOnly(cmd)
      const q = session.peek()
      if (q.length === 0) return reply('📥 queue empty')
      return reply(`📥 queued:\n${q.map((m, i) => `  ${i + 1}. ${m.text}`).join('\n')}`)
    }

    case 'clear':
      if (!session) return terminalOnly(cmd)
      return reply(`🧹 dropped ${session.clearQueue()} queued message(s)`)

    case 'quit':
    case 'exit':
      if (!session) return terminalOnly(cmd)
      return { handled: true, quit: true }

    // Unknown slash input is reported rather than sent to the model: a mistyped command that
    // silently becomes a chat message is confusing in a way a plain error is not.
    default:
      return reply(`❓ unknown command: /${cmd} — try /help`)
  }
}
