import type { AgentContext } from '../agent/context'
import type { ContextStatus } from '../agent/status'
import type { AgentLoopOptions, AgentResponse } from '../agent/types'
import type { ThinkingConfig } from '../providers/types'

/**
 * The seam between a surface and whatever drives a session.
 *
 * Channels, the terminal, the HTTP API, ACP and the slash commands all talk to one of
 * these; none of them knows or cares whether the session is driven by the local agent
 * loop or by something else entirely (a future Claude operator, a test stub). It is the
 * handful of things every surface needs: run a turn, stop the running turn, slip a
 * message into it, read and set thinking, look at the context, ask how full the window
 * is, and wipe or forget the session.
 *
 * Deliberately small. Everything local-loop-specific -- nudges, spiral and repetition
 * guards, compaction, rollover -- stays on the loop, not here.
 */
export interface Operator {
  /** Run one turn on this session, queuing behind the run in flight if there is one. */
  run(userMessage: string, options?: AgentLoopOptions): Promise<AgentResponse>
  /** Abort the in-flight run, if any. Returns false when nothing is running. */
  interrupt(): boolean
  /**
   * Queue a message into the in-flight run, delivered at the next turn boundary.
   * Returns false when nothing is running (send a normal chat message instead).
   */
  inject(message: string): boolean
  /** Whether a run is currently in flight on this session. */
  isRunning(): boolean
  /** The thinking level the next run will use, and whether it came from the session or config. */
  getThinking(): { level: ThinkingConfig['level']; source: 'session' | 'config' }
  /** Set the session's thinking level; `undefined` returns to the config default. */
  setThinking(level: ThinkingConfig['level'] | undefined): void
  /** The session's live context: messages, summary, system prompt. */
  getContext(): AgentContext
  /** A snapshot of the current context window usage. */
  contextStatus(): Promise<ContextStatus>
  /** Drop the live context and start the session over (history on disk is kept). */
  clearContext(): void
  /** Forget the session entirely, including its stored history. */
  resetSession(): void
}

/**
 * Compaction is a local-loop capability, not part of the seam: an operator that owns its
 * context window has nothing to compact. Surfaces that offer it check with canCompact
 * and say so instead of failing.
 */
export interface CompactingOperator extends Operator {
  compactNow(): Promise<{ messagesBefore: number; messagesAfter: number }>
}

/** Whether this operator manages its own context window, and so offers compaction. */
export function canCompact(op: Operator): op is CompactingOperator {
  return 'compactNow' in op
}
