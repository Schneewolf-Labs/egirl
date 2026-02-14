import OpenAI from 'openai'
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentPart,
  LLMProvider,
  ToolCall,
} from './types'
import { getTextContent } from './types'

function toOpenAIContent(parts: ContentPart[]): OpenAI.Chat.ChatCompletionContentPart[] {
  return parts.map((part): OpenAI.Chat.ChatCompletionContentPart => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text }
    }
    return { type: 'image_url', image_url: { url: part.image_url.url } }
  })
}

export class OpenAIProvider implements LLMProvider {
  readonly name: string
  private client: OpenAI
  private model: string

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.client = new OpenAI({ apiKey, ...(baseUrl && { baseURL: baseUrl }) })
    this.model = model
    this.name = `openai/${model}`
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages = this.prepareMessages(req.messages)

    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages,
      ...(req.max_tokens && { max_tokens: req.max_tokens }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
    }

    if (req.tools && req.tools.length > 0) {
      params.tools = req.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }

    if (req.onToken) {
      return this.chatStream(params, req.onToken)
    }

    const response = await this.client.chat.completions.create(params)

    const choice = response.choices[0]
    const tool_calls: ToolCall[] | undefined = choice?.message?.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }))

    return {
      content: choice?.message?.content ?? '',
      tool_calls,
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model,
    }
  }

  private async chatStream(
    params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    onToken: (token: string) => void,
  ): Promise<ChatResponse> {
    const stream = await this.client.chat.completions.create({
      ...params,
      stream: true,
      stream_options: { include_usage: true },
    })

    let content = ''
    const toolCallAccumulator = new Map<number, { id: string; name: string; arguments: string }>()
    let usage = { prompt_tokens: 0, completion_tokens: 0 }
    let model = this.model

    for await (const chunk of stream) {
      model = chunk.model ?? model

      if (chunk.usage) {
        usage = {
          prompt_tokens: chunk.usage.prompt_tokens ?? 0,
          completion_tokens: chunk.usage.completion_tokens ?? 0,
        }
      }

      const delta = chunk.choices?.[0]?.delta
      if (!delta) continue

      if (delta.content) {
        content += delta.content
        onToken(delta.content)
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallAccumulator.get(tc.index)
          if (existing) {
            existing.arguments += tc.function?.arguments ?? ''
          } else {
            toolCallAccumulator.set(tc.index, {
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              arguments: tc.function?.arguments ?? '',
            })
          }
        }
      }
    }

    const tool_calls: ToolCall[] | undefined =
      toolCallAccumulator.size > 0
        ? Array.from(toolCallAccumulator.values()).map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: JSON.parse(tc.arguments),
          }))
        : undefined

    return {
      content,
      tool_calls,
      usage: {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
      },
      model,
    }
  }

  private prepareMessages(messages: ChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'system') {
        return { role: 'system' as const, content: getTextContent(msg.content) }
      } else if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          return { role: 'user' as const, content: msg.content }
        }
        return {
          role: 'user' as const,
          content: toOpenAIContent(msg.content),
        }
      } else if (msg.role === 'assistant') {
        const text = getTextContent(msg.content)
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          return {
            role: 'assistant' as const,
            content: text || null,
            tool_calls: msg.tool_calls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          }
        }
        return { role: 'assistant' as const, content: text }
      } else if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: getTextContent(msg.content),
          tool_call_id: msg.tool_call_id!,
        }
      }
      throw new Error(`Unknown message role: ${msg.role}`)
    })
  }
}

export function createOpenAIProvider(apiKey: string, model: string, baseUrl?: string): LLMProvider {
  return new OpenAIProvider(apiKey, model, baseUrl)
}
