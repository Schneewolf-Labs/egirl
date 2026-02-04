// WebSocket protocol types for egirl gateway

export type MessageType =
  | 'chat'
  | 'tool_call'
  | 'tool_result'
  | 'stream_start'
  | 'stream_chunk'
  | 'stream_end'
  | 'error'
  | 'ping'
  | 'pong'

export interface BaseMessage {
  type: MessageType
  id: string
  timestamp: number
}

export interface ChatMessage extends BaseMessage {
  type: 'chat'
  sessionId: string
  role: 'user' | 'assistant'
  content: string
}

export interface ToolCallMessage extends BaseMessage {
  type: 'tool_call'
  sessionId: string
  toolName: string
  arguments: Record<string, unknown>
}

export interface ToolResultMessage extends BaseMessage {
  type: 'tool_result'
  sessionId: string
  toolCallId: string
  success: boolean
  output: string
}

export interface StreamChunkMessage extends BaseMessage {
  type: 'stream_chunk'
  sessionId: string
  content: string
}

export interface ErrorMessage extends BaseMessage {
  type: 'error'
  sessionId?: string
  error: string
  code?: string
}

export type GatewayMessage =
  | ChatMessage
  | ToolCallMessage
  | ToolResultMessage
  | StreamChunkMessage
  | ErrorMessage

export function createMessage<T extends GatewayMessage>(
  type: T['type'],
  data: Omit<T, 'type' | 'id' | 'timestamp'>
): T {
  return {
    type,
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    ...data,
  } as T
}
