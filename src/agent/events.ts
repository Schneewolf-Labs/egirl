import type { ToolCall } from '../providers/types'
import type { ToolResult } from '../tools/types'

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
}
