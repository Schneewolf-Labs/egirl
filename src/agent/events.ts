import type { ToolCall } from '../providers/types'
import type { ToolResult } from '../tools/types'
import type { RoutingDecision } from '../routing'
import type { EscalationDecision } from '../routing/escalation'

/**
 * Event handler for agent loop transparency.
 *
 * Channels implement this to display tool calls and stream
 * response tokens as they arrive.
 */
export interface AgentEventHandler {
  /** Called when the model emits thinking text alongside tool calls */
  onThinking?(text: string): void
  /** Called when tool calls are about to be executed */
  onToolCallStart?(calls: ToolCall[]): void
  /** Called after each tool finishes executing */
  onToolCallComplete?(callId: string, name: string, result: ToolResult): void
  /** Called for each streamed token of the response */
  onToken?(token: string): void
  /** Called when the full response is complete */
  onResponseComplete?(): void
  /** Called when an error occurs during agent processing */
  onError?(error: Error): void
  /** Called when routing decides which provider to use */
  onRoutingDecision?(decision: RoutingDecision): void
  /** Called when the agent escalates from local to remote */
  onEscalation?(decision: EscalationDecision, from: string, to: string): void
  /** Called before a single tool is executed. Return false to skip execution */
  onBeforeToolExec?(call: ToolCall): boolean | Promise<boolean>
  /** Called after a single tool finishes executing */
  onAfterToolExec?(call: ToolCall, result: ToolResult): void
}
