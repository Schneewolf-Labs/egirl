import type { RuntimeConfig } from '../config'
import type { ConversationStore } from '../conversation'
import type { MemoryManager } from '../memory'
import type { LLMProvider, ThinkingConfig } from '../providers/types'
import type { Skill } from '../skills/types'
import type { ToolExecutor } from '../tools'
import type { TranscriptLogger } from '../tracking/transcript'
import type { AgentEventHandler } from './events'
import type { SessionMutex } from './session-mutex'

export interface AgentLoopOptions {
  maxTurns?: number
  events?: AgentEventHandler
  /** Override thinking level for this run */
  thinking?: ThinkingConfig
  /** Planning mode: first response is a plan (no tools), user approves before execution */
  planningMode?: boolean
  /** Abort signal — checked between turns and after tool execution */
  signal?: AbortSignal
  /**
   * Images attached to the user message, as data: URLs. Rendered as image_url content parts
   * alongside the text -- the same shape the screenshot tool already feeds the provider, so
   * a vision-enabled server sees them and a text-only one degrades to the text.
   */
  images?: string[]
  /**
   * Turns between consolidation-break nudges (0 = off). Overrides the config default for this
   * run. A long autonomous task sets this; an interactive chat leaves it off. See
   * docs/autonomy-loop.md.
   */
  consolidationInterval?: number
}

export interface AgentResponse {
  content: string
  provider: string
  usage: {
    input_tokens: number
    output_tokens: number
  }
  turns: number
  /** True if the response is a plan awaiting approval (planning mode) */
  isPlan?: boolean
  /** Extended thinking content from the model */
  thinking?: string
  /** Number of continuation retries performed for truncated responses */
  continuationRetries?: number
  /** True if the run was cancelled via the abort signal */
  aborted?: boolean
}

export interface AgentLoopDeps {
  config: RuntimeConfig
  toolExecutor: ToolExecutor
  localProvider: LLMProvider
  /**
   * Optional smaller model for compaction summaries and memory extraction. Falls back to
   * localProvider when absent, which is the previous behaviour.
   */
  auxProvider?: LLMProvider
  sessionId: string
  memory?: MemoryManager
  conversationStore?: ConversationStore
  transcript?: TranscriptLogger
  skills?: Skill[]
  additionalContext?: string
  /** Shared mutex to serialize agent runs across entry points */
  sessionMutex?: SessionMutex
}
