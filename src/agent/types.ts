import type { RuntimeConfig } from '../config'
import type { ConversationStore } from '../conversation'
import type { MemoryManager } from '../memory'
import type { LLMProvider, ThinkingConfig } from '../providers/types'
import type { Skill } from '../skills/types'
import type { ToolExecutor } from '../tools'
import type { DelegationRegistry } from '../tools/delegation-registry'
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
  /**
   * Run without a normal turn cap. `maxTurns` is ignored in favour of a far-off safety
   * ceiling; the run ends on a mechanical failure, a semantic report, or its own conclusion.
   * For long autonomous tasks. See docs/autonomy-loop.md.
   */
  unbounded?: boolean
  /**
   * Wall-clock instant (ms epoch) at which this run will be hard-aborted by its caller (a task
   * timeout). Used only to warn the agent to wrap up BEFORE that happens, turning a mid-thought
   * guillotine into a self-directed wind-down. Undefined = no wall-clock limit.
   */
  deadline?: number
  /**
   * How long before `deadline` to inject the one-time wrap-up warning. The caller sets this to
   * leave enough room for the agent to checkpoint and conclude at its own pace. Default 7 min.
   */
  wrapupMarginMs?: number
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
  /** True if a tool reported it is waiting on supervisor input that never came */
  awaitingInput?: boolean
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
  /**
   * Background code-agent delegations. The loop drains their completion notices at turn
   * boundaries so a delegation that lands while the operator is working gets read, instead of
   * waiting for the operator to remember to poll `code_agent_status`.
   */
  delegations?: DelegationRegistry
}
