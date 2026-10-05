import { gitStdout } from '../../../util/git'

/**
 * What a timed-out code agent leaves behind for the operator.
 *
 * A bare "timed out after 1800s" says nothing about the state of the tree: had the agent merged,
 * half-resolved conflicts, built the venv? The report answers that from what the backend already
 * streamed (last actions, last message) plus a bounded look at git, and says how to continue.
 * It lands in a local model's context, so every section is capped.
 */

/** Every timeout result starts with this; failover keys off it (see failover.ts). */
export const TIMEOUT_PREFIX = 'Code agent timed out after'

const MAX_ACTIONS = 10
const MAX_SUMMARY_CHARS = 120
const MAX_MESSAGE_CHARS = 1200
const MAX_GIT_LINES = 20
const GIT_TIMEOUT_MS = 3000

export interface AgentAction {
  tool: string
  summary: string
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Keep the tail: the end of a message is where an agent says where it got to. */
function tail(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `…${trimmed.slice(-(max - 1))}` : trimmed
}

const SUMMARY_KEYS = [
  'command',
  'file_path',
  'notebook_path',
  'filePath',
  'pattern',
  'path',
  'url',
  'query',
  'description',
  'prompt',
]

/** A short, human-readable gist of a tool call's input: the command, the file, the pattern. */
export function summarizeToolInput(input: unknown): string {
  if (typeof input === 'string') return oneLine(input, MAX_SUMMARY_CHARS)
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of SUMMARY_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      const extra = key === 'pattern' && typeof record.path === 'string' ? ` in ${record.path}` : ''
      return oneLine(value + extra, MAX_SUMMARY_CHARS)
    }
  }
  try {
    return oneLine(JSON.stringify(input), MAX_SUMMARY_CHARS)
  } catch {
    return ''
  }
}

/** Ring of the most recent actions plus a total count. */
export class ActionLog {
  private readonly items: AgentAction[] = []
  total = 0

  add(tool: string, input: unknown): void {
    this.total++
    this.items.push({ tool, summary: summarizeToolInput(input) })
    if (this.items.length > MAX_ACTIONS) this.items.shift()
  }

  recent(): AgentAction[] {
    return [...this.items]
  }
}

function boundLines(text: string, max = MAX_GIT_LINES): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  if (lines.length <= max) return lines.join('\n')
  return `${lines.slice(0, max).join('\n')}\n… (+${lines.length - max} more lines)`
}

/**
 * `git status --short` and `git diff --stat` for the working dir, bounded. Undefined when the dir
 * is not a git work tree or git is unavailable; never throws, so it cannot mask the timeout.
 */
export async function gitSummary(
  workingDir: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<string | undefined> {
  try {
    const inside = await gitStdout(['rev-parse', '--is-inside-work-tree'], workingDir, timeoutMs)
    if (inside?.trim() !== 'true') return undefined
    const [status, diff] = await Promise.all([
      gitStdout(['status', '--short'], workingDir, timeoutMs),
      gitStdout(['diff', '--stat'], workingDir, timeoutMs),
    ])
    const parts: string[] = []
    if (status !== undefined)
      parts.push(`git status --short:\n${status.trim() ? boundLines(status) : '(clean)'}`)
    if (diff?.trim()) parts.push(`git diff --stat:\n${boundLines(diff)}`)
    return parts.length ? parts.join('\n\n') : undefined
  } catch {
    return undefined
  }
}

export interface TimeoutReportInput {
  provider: string
  timeoutMs: number
  workingDir: string
  turns?: number
  actions: ActionLog
  lastMessage?: string
  /** Session / thread id the backend can resume; omitted when it cannot. */
  sessionId?: string
}

export async function formatTimeoutReport(input: TimeoutReportInput): Promise<string> {
  const secs = (input.timeoutMs / 1000).toFixed(0)
  const stats = [
    input.provider,
    input.turns !== undefined ? `${input.turns} turns` : undefined,
    `${input.actions.total} tool calls`,
  ].filter(Boolean)
  const out: string[] = [
    `${TIMEOUT_PREFIX} ${secs}s (${stats.join(', ')}). The work is partial: check the state below before retrying.`,
  ]

  const recent = input.actions.recent()
  if (recent.length) {
    const label =
      input.actions.total > recent.length
        ? `Last ${recent.length} of ${input.actions.total} actions:`
        : 'Actions:'
    out.push(
      `${label}\n${recent.map((a) => `- ${a.tool}${a.summary ? `: ${a.summary}` : ''}`).join('\n')}`,
    )
  }

  if (input.lastMessage?.trim()) {
    out.push(`Last message from the agent:\n${tail(input.lastMessage, MAX_MESSAGE_CHARS)}`)
  }

  const git = await gitSummary(input.workingDir)
  if (git) out.push(git)

  out.push(
    input.sessionId
      ? `To continue: call code_agent again with resume_session="${input.provider}:${input.sessionId}" ` +
          'and a narrower task for the remaining work (for example "continue: <next step only>"), ' +
          'or split the rest into smaller tasks.'
      : 'This run cannot be resumed. Retry with a narrower task, or split the remaining work.',
  )
  return out.join('\n\n')
}

/**
 * `resume_session` as the report prints it, "provider:id". A bare id is accepted too, for the
 * model that drops the prefix; the caller then uses its first configured provider.
 */
export function parseResumeSession(
  value: string,
  providers: readonly string[],
): { provider?: string; id: string } {
  const trimmed = value.trim()
  const colon = trimmed.indexOf(':')
  if (colon > 0) {
    const provider = trimmed.slice(0, colon)
    if (providers.includes(provider)) return { provider, id: trimmed.slice(colon + 1) }
  }
  return { id: trimmed }
}
