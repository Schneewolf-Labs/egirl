import type { AgentEventHandler } from '../agent/events'
import type { AgentLoopOptions } from '../agent/types'
import type { ThinkingConfig, ToolDefinition } from '../providers/types'
import type { ToolResult } from '../tools/types'

/**
 * The contract between the hosted session (./hosted) and a harness: what one user turn hands
 * the harness, and what the harness hands back.
 */

/** What one hosted turn came back with, in egirl's terms. */
export interface HarnessOutcome {
  content: string
  thinking: string
  turns: number
  usage: { input_tokens: number; output_tokens: number }
  /** Prompt tokens of the last model call: what the context window holds now. */
  contextTokens: number
  /** The model's context window, when the harness reports it. */
  contextWindow?: number
  /** The model answered at least once: the session resumed and ran. */
  sawAssistant: boolean
  /** The run used up its turns: not a failure, the reply is whatever the model said last. */
  turnLimitReached?: boolean
  error?: string
}

export function emptyOutcome(): HarnessOutcome {
  return {
    content: '',
    thinking: '',
    turns: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    contextTokens: 0,
    sawAssistant: false,
  }
}

/** One user turn, as a harness drives it. */
export interface HarnessTurn {
  /** The user's text, with recalled memory and the attachment note. */
  body: string
  /** Attached images as data URLs, and the files they were saved to. */
  images?: string[]
  imagePaths?: string[]
  options: AgentLoopOptions
  events: AgentEventHandler
  /** Aborted by interrupt, the caller's signal, or end_task. */
  controller: AbortController
  thinking: ThinkingConfig['level']
  /** Every tool this turn may call: the registry, then the run's own. */
  tools: ToolDefinition[]
  /** Serve one tool call. Returns the result and a note to append to what the model sees. */
  callTool(name: string, args: Record<string, unknown>): Promise<ServedTool>
}

export interface ServedTool {
  result: ToolResult
  note?: string
}

export type Drive = (turn: HarnessTurn) => Promise<HarnessOutcome>
