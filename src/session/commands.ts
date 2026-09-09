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
import type { Skill } from '../skills/types'
import type { SessionController } from './controller'

/** A command and what it did, or why it did nothing. */
export interface CommandResult {
  handled: boolean
  message?: string
  quit?: boolean
  /**
   * A custom command expands into this text, which the caller runs as a normal turn. It is
   * the one kind of command that does reach the model: the skill's instructions plus the
   * user's arguments, so `/draw a fox` is "please draw a fox" with the drawing skill loaded.
   */
  turn?: string
}

/** Who is asking, as the channel knows them. Absent on the terminal, which is the owner. */
export interface Caller {
  userId?: string
  /** On the channel's allowed-users list (or the list is empty, which allows everyone). */
  allowed: boolean
  /** On the channel's owner list. */
  owner: boolean
}

export interface CommandScope {
  agent: AgentLoop
  /** Terminal-only state. Absent on a chat channel. */
  session?: SessionController
  /** Skills that may declare commands (see `egirl.command` in SKILL.md). */
  skills?: Skill[]
  caller?: Caller
}

export type CommandPermission = NonNullable<
  NonNullable<NonNullable<Skill['metadata']['egirl']>['command']>['permission']
>

/** A slash command declared by a skill. */
export interface CustomCommand {
  name: string
  description: string
  args?: string
  permission: CommandPermission
  /** The declaring skill's name, for logs and the Discord picker. */
  skill: string
}

const BUILTIN = new Set([
  'think',
  'status',
  'context',
  'settings',
  'help',
  'auto',
  'maxturns',
  'reasoning',
  'queue',
  'clear',
  'quit',
  'exit',
])

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/**
 * The commands a set of skills declares. A skill whose command name collides with a built-in
 * is dropped: the built-in vocabulary is the same on every surface and must stay that way.
 */
export function customCommands(skills: Skill[]): CustomCommand[] {
  const out: CustomCommand[] = []
  const seen = new Set<string>()
  for (const s of skills) {
    const c = s.metadata.egirl?.command
    if (!c || !s.enabled) continue
    const name = slug(c.name ?? s.name)
    if (!name || BUILTIN.has(name) || seen.has(name)) continue
    seen.add(name)
    out.push({
      name,
      description: c.description?.trim() || s.description,
      ...(c.args ? { args: c.args } : {}),
      permission: c.permission ?? 'everyone',
      skill: s.name,
    })
  }
  return out
}

function permitted(cmd: CustomCommand, caller: Caller | undefined): boolean {
  if (!caller) return true // the terminal: the owner is typing
  if (cmd.permission === 'everyone') return true
  if (cmd.permission === 'allowed') return caller.allowed || caller.owner
  return caller.owner
}

/** The turn a custom command becomes. The skill body rides along so a small model cannot miss it. */
function expandCommand(cmd: CustomCommand, skill: Skill, arg: string): string {
  const request = arg
    ? `Request: ${arg}`
    : `The user gave no arguments${cmd.args ? ` (this command takes: ${cmd.args})` : ''}; ask for what you need or proceed if the skill says how.`
  return [
    `The user invoked /${cmd.name}. Follow the "${skill.name}" skill below for this request.`,
    '',
    skill.content.trim(),
    '',
    request,
  ].join('\n')
}

type ThinkingLevel = ThinkingConfig['level']
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high']

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value)
}

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
  for (const c of customCommands(scope.skills ?? [])) {
    const who = c.permission === 'everyone' ? '' : ` (${c.permission})`
    lines.push(`✨ /${c.name}${c.args ? ` <${c.args}>` : ''} — ${c.description}${who}`)
  }
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
  if (!BUILTIN.has(cmd)) {
    const custom = customCommands(scope.skills ?? []).find((c) => c.name === cmd)
    if (custom) {
      if (!permitted(custom, scope.caller)) {
        return reply(
          `🔒 /${custom.name} is for ${custom.permission === 'owner' ? 'the owner' : 'allowed users'}`,
        )
      }
      const skill = (scope.skills ?? []).find((sk) => sk.name === custom.skill)
      if (!skill) return reply(`⚠️ /${custom.name}: its skill is no longer loaded`)
      return { handled: true, turn: expandCommand(custom, skill, arg) }
    }
  }

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
