import type { AgentEventHandler } from '../agent/events'
import type { ToolCall } from '../providers/types'
import type { ToolResult } from '../tools/types'
import { colors, DIM, RESET } from '../ui/theme'
import type { StatusLine } from './cli-status'

export interface CLIEventState {
  streamed: boolean
  showThinking: boolean
  /** Reasoning was already printed live, so the block that arrives at the end is a duplicate. */
  streamedThinking: boolean
}

/**
 * A turn reads as a list of events, each opened by a bullet, with a tool's output hanging off
 * its call rather than floating loose in the scrollback. The glyphs do the structural work so
 * the text itself needs no prefixes.
 *
 * The shapes are Claude Code's -- bullet per event, elbow for attached output -- because that
 * layout survives long sessions. The dressing is ours: vapor palette, a sparkle where the
 * answer starts, a heart on messages the user slipped in mid-turn.
 */
const BULLET = '✦'
const ELBOW = '⎿'
const SPARK = '✧'
const HEART = '♡'

/** Result lines shown before the rest is summarized away. */
const MAX_RESULT_LINES = 4

/**
 * Trim output to a few lines and say how many were withheld.
 *
 * By line rather than by character: a character cap cuts mid-token and leaves output that
 * looks corrupted rather than shortened, and "+18 lines" tells you how much you are not
 * seeing, which a trailing ellipsis does not.
 */
export function previewLines(
  output: string,
  maxLines: number = MAX_RESULT_LINES,
): { lines: string[]; hidden: number } {
  const trimmed = output.trim()
  if (!trimmed) return { lines: [], hidden: 0 }
  const all = trimmed.split('\n')
  if (all.length <= maxLines) return { lines: all, hidden: 0 }
  return { lines: all.slice(0, maxLines), hidden: all.length - maxLines }
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
  if (entries.length === 0) return ''
  if (entries.length === 1) {
    const entry = entries[0]
    if (!entry) return ''
    const [key, val] = entry
    const valStr = typeof val === 'string' ? val : JSON.stringify(val)
    if (valStr.length < 60) return `${key}: ${valStr}`
  }
  return JSON.stringify(args, null, 2)
}

/**
 * Build the per-run event handler that prints thinking text, tool calls,
 * streamed tokens, and completion markers to stdout.
 * Returns the handler and a state object the caller checks to see whether
 * streaming actually happened (so it can print the response directly if not).
 */
export function createCLIEventHandler(
  showThinking: boolean,
  status?: StatusLine,
): {
  handler: AgentEventHandler
  state: CLIEventState
} {
  const state: CLIEventState = { streamed: false, showThinking, streamedThinking: false }

  const handler: AgentEventHandler = {
    // Reasoning as it happens. On a reasoning model this is most of the turn, so printing it
    // live is the difference between watching the model work and staring at a blank terminal
    // for a minute. Dimmed and unprefixed per token: it is context, not the answer.
    onThinkingToken(token: string) {
      // Reasoning arriving means prefill is over and the model is genuinely deliberating.
      // With the reasoning hidden, the spinner is the only sign of that; with it shown, the
      // text is its own progress and an animation repainting over it would corrupt the output.
      if (!state.showThinking) {
        status?.set('thinking')
        return
      }
      status?.set('idle')
      if (!state.streamedThinking) {
        const c = colors()
        process.stdout.write(`\n${c.info}${SPARK} thinking${RESET}${DIM}\n`)
        state.streamedThinking = true
      }
      process.stdout.write(`${DIM}${token}${RESET}`)
    },

    onThinking(text: string) {
      status?.clear()
      // Already shown token by token; reprinting the assembled block would double it.
      if (state.streamedThinking) return
      if (!state.showThinking || !text.trim()) return
      const c = colors()
      const { lines, hidden } = previewLines(text, 20)
      const display = hidden
        ? [...lines, `${DIM}… +${hidden} lines${RESET}`].join('\n')
        : lines.join('\n')
      process.stdout.write(`\n${c.info}${SPARK} thinking${RESET}\n${DIM}${display}${RESET}\n`)
    },

    onToolCallStart(calls: ToolCall[]) {
      status?.clear()
      const c = colors()
      for (const call of calls) {
        const args = formatArgs(call.arguments)
        // Bullet in the accent, name carrying its own weight, args dimmed: at a glance the
        // scrollback reads as a list of what she did, not a wall of grey.
        if (args.includes('\n')) {
          process.stdout.write(
            `\n${c.accent}${BULLET}${RESET} ${c.primary}${call.name}${RESET}${DIM}(\n${args}\n  )${RESET}\n`,
          )
        } else {
          process.stdout.write(
            `\n${c.accent}${BULLET}${RESET} ${c.primary}${call.name}${RESET}${DIM}(${args})${RESET}\n`,
          )
        }
      }
      // Now the wait is the tool, not the model — say which one is running.
      status?.set('tool', calls.map((call) => call.name).join(', '))
    },

    onToolCallComplete(_callId: string, name: string, result: ToolResult) {
      status?.clear()
      const c = colors()
      const { lines, hidden } = previewLines(result.output)
      // Output hangs off the call it belongs to. Success needs no announcement -- the output
      // is the announcement -- but a failure gets named in the error color.
      const head = result.success ? '' : ` ${c.error}${name} failed${RESET}`
      if (lines.length === 0) {
        process.stdout.write(
          `  ${c.muted}${ELBOW}${RESET}${head}${head ? '' : ` ${DIM}(no output)${RESET}`}\n`,
        )
      } else {
        process.stdout.write(`  ${c.muted}${ELBOW}${RESET}${head}${head ? '\n' : ''}`)
        for (const [i, line] of lines.entries()) {
          const pad = i === 0 && !head ? ' ' : '    '
          process.stdout.write(`${pad}${DIM}${line}${RESET}\n`)
        }
        if (hidden) process.stdout.write(`    ${c.muted}… +${hidden} lines${RESET}\n`)
      }
      // Control returns to the model, which will deliberate again before its next move.
      status?.set('waiting')
    },

    onToken(token: string) {
      if (!state.streamed) {
        // First content token: the answer has started, and the answer streaming in is better
        // feedback than any spinner. Stop it rather than let it repaint over the text.
        status?.set('idle')
        const c = colors()
        // Close the reasoning block so the answer does not run on from the last thought.
        if (state.streamedThinking) process.stdout.write('\n')
        process.stdout.write(`\n${c.secondary}${BULLET} egirl${RESET} `)
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

/**
 * A message the user typed while the turn was still running.
 *
 * Rendered inside the turn with a heart, the way Claude Code surfaces mid-turn input --
 * acknowledged where it happened, picked up when the turn ends. The heart is not decoration:
 * it marks the one line in the event stream that came from the user.
 */
export function renderQueuedMessage(text: string): string {
  const c = colors()
  const shown = text.length > 60 ? `${text.slice(0, 60)}…` : text
  return `  ${c.secondary}${HEART}${RESET} ${DIM}queued:${RESET} ${shown}`
}
