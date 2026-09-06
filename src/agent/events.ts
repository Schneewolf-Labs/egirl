import type {
  ChatMessage,
  ChatResponse,
  ThinkingConfig,
  ToolCall,
  ToolDefinition,
} from '../providers/types'
import type { ToolResult } from '../tools/types'
import { publish } from './session-events'
import type { BudgetLevel, BudgetStatus } from './token-budget'

/**
 * One round trip to the model, as the provider saw it: the fitted message array, the tool
 * definitions, the thinking config, and the raw response. This is the unit a training example
 * is cut from, so it is captured here rather than reconstructed from persisted history (which
 * drops ephemeral recovery turns and never records what fitting trimmed).
 */
export interface ModelTurn {
  messages: ChatMessage[]
  tools: ToolDefinition[]
  thinking?: ThinkingConfig
  response: ChatResponse
}

/**
 * The caller's handler, with the streaming events also published on the session bus. Only the
 * narration hooks are wrapped: the others (validation, before/after tool hooks) change the
 * loop's behaviour, and tool-runner picks its execution path by whether they are defined.
 * Tool completion is published by tool-runner itself, which holds the call and its result.
 */
export function publishingEvents(
  sessionId: string,
  caller: AgentEventHandler | undefined,
): AgentEventHandler {
  return {
    ...caller,
    onThinkingToken(token) {
      publish(sessionId, { t: 'reasoning', v: token })
      caller?.onThinkingToken?.(token)
    },
    onToken(token) {
      publish(sessionId, { t: 'token', v: token })
      caller?.onToken?.(token)
    },
    onToolCallStart(calls) {
      publish(sessionId, { t: 'tool', v: calls.map((c) => c.name) })
      caller?.onToolCallStart?.(calls)
    },
  }
}

/**
 * Result of post-response validation.
 * Return { valid: true } to accept the response,
 * or { valid: false, feedback } to reject and retry.
 */
export interface ValidationResult {
  valid: boolean
  /** Feedback injected as a user message when retrying */
  feedback?: string
}

/**
 * Event handler for agent loop transparency.
 *
 * Channels implement this to display tool calls and stream
 * response tokens as they arrive.
 */
export interface AgentEventHandler {
  /** Called when the model emits thinking text alongside tool calls */
  onThinking?(text: string): void
  /**
   * Called for each streamed token of the model's reasoning, before any answer exists.
   *
   * Distinct from `onThinking`, which fires once with the completed block after generation
   * finishes. On a reasoning model most of a turn is spent here — measured 96% of output
   * tokens on one Qwen3.8 turn — so without this the interface has nothing to show for
   * minutes at a stretch and looks hung.
   */
  onThinkingToken?(token: string): void
  /** Called when tool calls are about to be executed */
  onToolCallStart?(calls: ToolCall[]): void
  /** Called after each tool finishes executing */
  onToolCallComplete?(callId: string, name: string, result: ToolResult): void
  /** Called for each streamed token of the response */
  onToken?(token: string): void
  /** Called when the full response is complete */
  onResponseComplete?(): void
  /** Called after every model round trip with exactly what was sent and what came back */
  onModelTurn?(turn: ModelTurn): void
  /** Called when an error occurs during agent processing */
  onError?(error: Error): void
  /** Called before a single tool is executed. Return false to skip execution */
  onBeforeToolExec?(call: ToolCall): boolean | Promise<boolean>
  /** Called after a single tool finishes executing */
  onAfterToolExec?(call: ToolCall, result: ToolResult): void
  /** Called when token budget utilization crosses a threshold (high or critical) */
  onTokenBudgetWarning?(level: BudgetLevel, status: BudgetStatus): void
  /**
   * Post-response validation hook. Called after the model produces a final text
   * response (no tool calls). Return { valid: false, feedback } to reject the
   * response and retry with the feedback injected as a user message.
   * Only retried once to prevent infinite loops.
   */
  onPostResponseValidation?(response: string): ValidationResult | Promise<ValidationResult>
}
