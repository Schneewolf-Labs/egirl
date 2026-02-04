import OpenAI from 'openai'
import type { LLMProvider, ChatRequest, ChatResponse, ChatStreamChunk, ToolCall, ChatMessage } from '../types'

export class OpenAIProvider implements LLMProvider {
  name: string
  type: 'remote' = 'remote'
  private client: OpenAI
  private model: string

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey })
    this.model = model
    this.name = `openai/${model}`
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const messages = this.prepareMessages(request.messages)

    const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
      model: this.model,
      messages,
      ...(request.maxTokens && { max_tokens: request.maxTokens }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
    }

    if (request.tools && request.tools.length > 0) {
      openaiRequest.tools = request.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }

    const response = await this.client.chat.completions.create(openaiRequest)

    const choice = response.choices[0]
    const toolCalls: ToolCall[] | undefined = choice?.message?.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }))

    return {
      content: choice?.message?.content ?? '',
      toolCalls,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model,
      provider: 'remote',
    }
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const messages = this.prepareMessages(request.messages)

    const openaiRequest: OpenAI.Chat.ChatCompletionCreateParams = {
      model: this.model,
      messages,
      stream: true,
      ...(request.maxTokens && { max_tokens: request.maxTokens }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
    }

    if (request.tools && request.tools.length > 0) {
      openaiRequest.tools = request.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }

    const stream = await this.client.chat.completions.create(openaiRequest)

    const toolCalls: Map<number, Partial<ToolCall>> = new Map()

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta

      if (delta?.content) {
        yield { type: 'content', content: delta.content }
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          let existing = toolCalls.get(tc.index)
          if (!existing) {
            existing = { id: tc.id, name: tc.function?.name }
            toolCalls.set(tc.index, existing)
          }

          if (tc.function?.name) {
            existing.name = tc.function.name
          }

          if (tc.function?.arguments) {
            if (!existing.arguments) {
              existing.arguments = {} as Record<string, unknown>
            }
            // Accumulate arguments string
            const argsStr = (existing as { _argsStr?: string })._argsStr ?? ''
            ;(existing as { _argsStr?: string })._argsStr = argsStr + tc.function.arguments
          }
        }
      }

      if (chunk.choices[0]?.finish_reason === 'tool_calls') {
        for (const tc of toolCalls.values()) {
          try {
            tc.arguments = JSON.parse((tc as { _argsStr?: string })._argsStr ?? '{}')
          } catch {
            tc.arguments = {}
          }
          yield { type: 'tool_call', toolCall: tc }
        }
      }

      if (chunk.usage) {
        yield {
          type: 'done',
          usage: {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          },
        }
      }
    }
  }

  private prepareMessages(messages: ChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map(msg => {
      if (msg.role === 'system') {
        return { role: 'system', content: msg.content }
      } else if (msg.role === 'user') {
        return { role: 'user', content: msg.content }
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          return {
            role: 'assistant',
            content: msg.content || null,
            tool_calls: msg.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          }
        }
        return { role: 'assistant', content: msg.content }
      } else if (msg.role === 'tool') {
        return {
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.toolCallId!,
        }
      }
      throw new Error(`Unknown message role: ${msg.role}`)
    })
  }
}

export function createOpenAIProvider(apiKey: string, model: string): LLMProvider {
  return new OpenAIProvider(apiKey, model)
}
