import type { AgentContext } from '../agent/context'
import type { ContextStatus } from '../agent/status'
import type { AgentLoopOptions, AgentResponse } from '../agent/types'
import type { ThinkingConfig } from '../providers/types'

/**
 * The operator: the one model that drives a session, as every surface sees it.
 *
 * A chat channel, the terminal, the HTTP API and the slash commands all need the same handful
 * of things from whatever is answering: run a turn, stop it, poke a message into it, read the
 * session's state. The local AgentLoop is one implementation; a hosted harness driven through
 * its own SDK (src/operator/claude.ts) is another. Nothing routes between them: an instance is
 * configured with one operator and keeps it. Three hardcoded implementations, no registry.
 */
export interface Operator {
  run(message: string, options?: AgentLoopOptions): Promise<AgentResponse>
  /** Abort the in-flight run. False when nothing is running. */
  interrupt(): boolean
  /** Queue a message into the in-flight run. False when nothing is running or the operator cannot. */
  inject(message: string): boolean
  isRunning(): boolean
  setThinking(level: ThinkingConfig['level'] | undefined): void
  getThinking(): { level: ThinkingConfig['level']; source: 'session' | 'config' }
  /** The session as this process sees it; for a hosted operator a mirror of the harness's own. */
  getContext(): AgentContext
  contextStatus(): Promise<ContextStatus>
  /** Forget the live conversation but keep what is stored. */
  clearContext(): void
  /** Forget the conversation and delete what is stored. */
  resetSession(): void
  /** Manual compaction. Absent where the operator's harness owns the context window. */
  compactNow?(): Promise<{ messagesBefore: number; messagesAfter: number }>
}

export type OperatorFactory = (sessionId: string) => Operator
