import OpenAI from 'openai'
import type { LLMProvider, ChatRequest, ChatResponse, ToolCall, ChatMessage } from './types'

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

    const openaiReq: OpenAI.Chat.ChatCompletionCreateParams = {
      model: this.model,
      messages,
      ...(req.max_tokens && { max_tokens: req.max_tokens }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
    }

    if (req.tools && req.tools.length > 0) {
      openaiReq.tools = req.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }

    const response = await this.client.chat.completions.create(openaiReq)

    const choice = response.choices[0]
    const tool_calls: ToolCall[] | undefined = choice?.message?.tool_calls?.map(tc => ({
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

  private prepareMessages(messages: ChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map(msg => {
      if (msg.role === 'system') {
        return { role: 'system', content: msg.content }
      } else if (msg.role === 'user') {
        return { role: 'user', content: msg.content }
      } else if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          return {
            role: 'assistant',
            content: msg.content || null,
            tool_calls: msg.tool_calls.map(tc => ({
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
