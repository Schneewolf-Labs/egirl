import Anthropic from '@anthropic-ai/sdk'
import type { LLMProvider, ChatRequest, ChatResponse, ToolCall, ChatMessage, ContentPart } from './types'
import { getTextContent } from './types'

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

    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: req.max_tokens ?? 4096,
      messages,
      ...(systemPrompt && { system: systemPrompt }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
    }

    if (req.tools && req.tools.length > 0) {
      params.tools = req.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Messages.Tool['input_schema'],
      }))
    }

    if (req.onToken) {
      return this.chatStream(params, req.onToken)
    }

    const response = await this.client.messages.create(params)

    return this.parseResponse(response)
  }

  private async chatStream(
    params: Anthropic.Messages.MessageCreateParamsNonStreaming,
    onToken: (token: string) => void
  ): Promise<ChatResponse> {
    const stream = this.client.messages.stream(params)

    stream.on('text', (text) => {
      onToken(text)
    })

    const response = await stream.finalMessage()
    return this.parseResponse(response)
  }

  private parseResponse(response: Anthropic.Messages.Message): ChatResponse {
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
    return prepareAnthropicMessages(messages)
  }
}

/**
 * Convert internal ContentPart[] to Anthropic content blocks.
 */
function toAnthropicContent(parts: ContentPart[]): Anthropic.Messages.ContentBlockParam[] {
  return parts.map((part): Anthropic.Messages.ContentBlockParam => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text }
    }
    return {
      type: 'image',
      source: { type: 'url', url: part.image_url.url },
    }
  })
}

/**
 * Convert internal ChatMessage array to Anthropic API format.
 * Handles system prompt extraction, tool_use blocks on assistant messages,
 * and merging consecutive tool results into a single user message.
 */
export function prepareAnthropicMessages(messages: ChatMessage[]): {
  systemPrompt: string | undefined
  messages: Anthropic.Messages.MessageParam[]
} {
  let systemPrompt: string | undefined
  const anthropicMessages: Anthropic.Messages.MessageParam[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!

    if (msg.role === 'system') {
      const text = getTextContent(msg.content)
      systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') + text
      i++
    } else if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        anthropicMessages.push({ role: 'user', content: msg.content })
      } else {
        anthropicMessages.push({ role: 'user', content: toAnthropicContent(msg.content) })
      }
      i++
    } else if (msg.role === 'assistant') {
      const text = getTextContent(msg.content)
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const content: Anthropic.Messages.ContentBlockParam[] = []
        if (text) {
          content.push({ type: 'text', text })
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
        anthropicMessages.push({ role: 'assistant', content: text })
      }
      i++
    } else if (msg.role === 'tool') {
      // Group consecutive tool results into a single user message
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []
      while (i < messages.length && messages[i]!.role === 'tool') {
        const toolMsg = messages[i]!
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolMsg.tool_call_id!,
          content: getTextContent(toolMsg.content),
        })
        i++
      }
      anthropicMessages.push({ role: 'user', content: toolResults })
    } else {
      i++
    }
  }

  return { systemPrompt, messages: anthropicMessages }
}

export function createAnthropicProvider(apiKey: string, model: string): LLMProvider {
  return new AnthropicProvider(apiKey, model)
}
