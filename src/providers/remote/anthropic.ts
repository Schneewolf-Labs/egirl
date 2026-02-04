import Anthropic from '@anthropic-ai/sdk'
import type { LLMProvider, ChatRequest, ChatResponse, ChatStreamChunk, ToolCall, ChatMessage } from '../types'

export class AnthropicProvider implements LLMProvider {
  name: string
  type: 'remote' = 'remote'
  private client: Anthropic
  private model: string

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey })
    this.model = model
    this.name = `anthropic/${model}`
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { systemPrompt, messages } = this.prepareMessages(request.messages)

    const anthropicRequest: Anthropic.Messages.MessageCreateParams = {
      model: this.model,
      max_tokens: request.maxTokens ?? 4096,
      messages,
      ...(systemPrompt && { system: systemPrompt }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
    }

    if (request.tools && request.tools.length > 0) {
      anthropicRequest.tools = request.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Messages.Tool['input_schema'],
      }))
    }

    const response = await this.client.messages.create(anthropicRequest)

    let content = ''
    const toolCalls: ToolCall[] = []

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        })
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      model: response.model,
      provider: 'remote',
    }
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const { systemPrompt, messages } = this.prepareMessages(request.messages)

    const anthropicRequest: Anthropic.Messages.MessageCreateParams = {
      model: this.model,
      max_tokens: request.maxTokens ?? 4096,
      messages,
      stream: true,
      ...(systemPrompt && { system: systemPrompt }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
    }

    if (request.tools && request.tools.length > 0) {
      anthropicRequest.tools = request.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Messages.Tool['input_schema'],
      }))
    }

    const stream = this.client.messages.stream(anthropicRequest)

    let currentToolCall: Partial<ToolCall> | null = null
    let toolInputJson = ''

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          currentToolCall = {
            id: event.content_block.id,
            name: event.content_block.name,
          }
          toolInputJson = ''
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'content', content: event.delta.text }
        } else if (event.delta.type === 'input_json_delta') {
          toolInputJson += event.delta.partial_json
        }
      } else if (event.type === 'content_block_stop') {
        if (currentToolCall) {
          try {
            currentToolCall.arguments = JSON.parse(toolInputJson)
          } catch {
            currentToolCall.arguments = {}
          }
          yield { type: 'tool_call', toolCall: currentToolCall }
          currentToolCall = null
        }
      } else if (event.type === 'message_delta') {
        if (event.usage) {
          yield {
            type: 'done',
            usage: {
              inputTokens: 0,  // Input tokens not in delta
              outputTokens: event.usage.output_tokens,
            },
          }
        }
      }
    }
  }

  private prepareMessages(messages: ChatMessage[]): {
    systemPrompt: string | undefined
    messages: Anthropic.Messages.MessageParam[]
  } {
    let systemPrompt: string | undefined
    const anthropicMessages: Anthropic.Messages.MessageParam[] = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') + msg.content
      } else if (msg.role === 'user') {
        anthropicMessages.push({ role: 'user', content: msg.content })
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const content: Anthropic.Messages.ContentBlockParam[] = []
          if (msg.content) {
            content.push({ type: 'text', text: msg.content })
          }
          for (const tc of msg.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            })
          }
          anthropicMessages.push({ role: 'assistant', content })
        } else {
          anthropicMessages.push({ role: 'assistant', content: msg.content })
        }
      } else if (msg.role === 'tool') {
        anthropicMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.toolCallId!,
            content: msg.content,
          }],
        })
      }
    }

    return { systemPrompt, messages: anthropicMessages }
  }
}

export function createAnthropicProvider(apiKey: string, model: string): LLMProvider {
  return new AnthropicProvider(apiKey, model)
}
