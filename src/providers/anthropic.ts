import Anthropic from '@anthropic-ai/sdk'
import type { LLMProvider, ChatRequest, ChatResponse, ToolCall, ChatMessage } from './types'

export class AnthropicProvider implements LLMProvider {
  readonly name: string
  private client: Anthropic
  private model: string

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey })
    this.model = model
    this.name = `anthropic/${model}`
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const { systemPrompt, messages } = this.prepareMessages(req.messages)

    const anthropicReq: Anthropic.Messages.MessageCreateParams = {
      model: this.model,
      max_tokens: req.max_tokens ?? 4096,
      messages,
      ...(systemPrompt && { system: systemPrompt }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
    }

    if (req.tools && req.tools.length > 0) {
      anthropicReq.tools = req.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Messages.Tool['input_schema'],
      }))
    }

    const response = await this.client.messages.create(anthropicReq)

    let content = ''
    const tool_calls: ToolCall[] = []

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text
      } else if (block.type === 'tool_use') {
        tool_calls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        })
      }
    }

    return {
      content,
      tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
      model: response.model,
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
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const content: Anthropic.Messages.ContentBlockParam[] = []
          if (msg.content) {
            content.push({ type: 'text', text: msg.content })
          }
          for (const tc of msg.tool_calls) {
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
            tool_use_id: msg.tool_call_id!,
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
