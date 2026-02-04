import type { ChatStreamChunk, ToolCall } from '../providers/types'

export interface StreamHandler {
  onContent?(content: string): void
  onToolCall?(toolCall: ToolCall): void
  onDone?(usage: { inputTokens: number; outputTokens: number }): void
  onError?(error: Error): void
}

export async function handleStream(
  stream: AsyncIterable<ChatStreamChunk>,
  handler: StreamHandler
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  let content = ''
  const toolCalls: ToolCall[] = []
  const pendingToolCalls: Map<string, Partial<ToolCall>> = new Map()

  try {
    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'content':
          if (chunk.content) {
            content += chunk.content
            handler.onContent?.(chunk.content)
          }
          break

        case 'tool_call':
          if (chunk.toolCall) {
            const id = chunk.toolCall.id ?? `call_${pendingToolCalls.size}`
            let pending = pendingToolCalls.get(id)

            if (!pending) {
              pending = { id }
              pendingToolCalls.set(id, pending)
            }

            if (chunk.toolCall.name) pending.name = chunk.toolCall.name
            if (chunk.toolCall.arguments) pending.arguments = chunk.toolCall.arguments

            // If complete, emit it
            if (pending.name && pending.arguments) {
              const complete: ToolCall = {
                id: pending.id!,
                name: pending.name,
                arguments: pending.arguments,
              }
              toolCalls.push(complete)
              handler.onToolCall?.(complete)
              pendingToolCalls.delete(id)
            }
          }
          break

        case 'done':
          if (chunk.usage) {
            handler.onDone?.(chunk.usage)
          }
          break
      }
    }
  } catch (error) {
    handler.onError?.(error instanceof Error ? error : new Error(String(error)))
    throw error
  }

  return { content, toolCalls }
}

export function createConsoleStreamHandler(): StreamHandler {
  return {
    onContent(content: string) {
      process.stdout.write(content)
    },
    onToolCall(toolCall: ToolCall) {
      console.log(`\n[Tool Call: ${toolCall.name}]`)
    },
    onDone(usage) {
      console.log(`\n[Done: ${usage.inputTokens} in, ${usage.outputTokens} out]`)
    },
    onError(error: Error) {
      console.error(`\n[Error: ${error.message}]`)
    },
  }
}
