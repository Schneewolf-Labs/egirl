/**
 * What a run's tools actually reported, for its wrap-up.
 *
 * A wrap-up written from memory claims more than the run did: Jaeger's summary of a session in
 * which 20 of 64 commands failed reported the work as done, and his own soul file already told
 * him to say what was verified. Asking harder does not fix that; showing the record does. So
 * every tool result is tallied here, and when the run is told to wrap up it is handed this:
 * how many calls failed, which commands were still failing the last time they ran, what was
 * written and committed. Its claims can then be sorted against evidence instead of recollection.
 */

import type { ToolResult } from '../tools/types'

interface CommandOutcome {
  command: string
  success: boolean
}

const MAX_LISTED = 8
const MAX_COMMAND_CHARS = 100

const WRITES = new Set(['write_file', 'edit_file'])

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_COMMAND_CHARS ? `${flat.slice(0, MAX_COMMAND_CHARS - 1)}…` : flat
}

function listed(items: string[]): string {
  const shown = items.slice(-MAX_LISTED)
  const more = items.length > shown.length ? ` (+${items.length - shown.length} earlier)` : ''
  return `${shown.join(', ')}${more}`
}

export class RunLedger {
  private calls = 0
  private failed = 0
  /** Last outcome of each distinct command: a test that failed and then passed has passed. */
  private commands = new Map<string, CommandOutcome>()
  private written = new Set<string>()
  private commits: string[] = []
  private delegations: { success: boolean }[] = []

  record(name: string, args: Record<string, unknown>, result: ToolResult): void {
    this.calls++
    if (!result.success) this.failed++
    const command = typeof args.command === 'string' ? oneLine(args.command) : undefined
    if (name === 'execute_command' && command) {
      this.commands.delete(command)
      this.commands.set(command, { command, success: result.success })
    }
    if (WRITES.has(name) && result.success && typeof args.path === 'string') {
      this.written.add(args.path)
    }
    if (name === 'git_commit' && result.success) {
      this.commits.push(typeof args.message === 'string' ? oneLine(args.message) : 'commit')
    }
    if (name === 'code_agent') this.delegations.push({ success: result.success })
  }

  /** The record as the wrap-up sees it; undefined when the run called no tools. */
  render(): string | undefined {
    if (this.calls === 0) return undefined
    const lines = [
      `This run's record (from the tool results, not your recollection): ${this.calls} tool calls, ${this.failed} failed.`,
    ]
    const outcomes = [...this.commands.values()]
    if (outcomes.length > 0) {
      const failing = outcomes.filter((o) => !o.success).map((o) => `\`${o.command}\``)
      lines.push(
        failing.length > 0
          ? `- Commands still failing the last time they ran: ${listed(failing)}`
          : `- Commands: ${outcomes.length} distinct, each succeeded the last time it ran`,
      )
    }
    if (this.written.size > 0) lines.push(`- Files written or edited: ${listed([...this.written])}`)
    lines.push(
      this.commits.length > 0
        ? `- Commits: ${listed(this.commits)}`
        : '- Commits: none through git_commit (a commit made in a shell command or by the code agent is not counted here)',
    )
    if (this.delegations.length > 0) {
      const ok = this.delegations.filter((d) => d.success).length
      lines.push(
        `- Code agent: ${this.delegations.length} delegations, ${ok} succeeded (its report is a claim; check its evidence section)`,
      )
    }
    return lines.join('\n')
  }
}

/** A wrap-up instruction followed by the run's record, when it has one. */
export function withRecord(instruction: string, ledger: RunLedger | undefined): string {
  const record = ledger?.render()
  return record ? `${instruction}\n\n${record}` : instruction
}
