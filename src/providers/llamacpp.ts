import type { LLMProvider, ChatRequest, ChatResponse, ChatMessage } from './types'
import { parseToolCalls, buildToolsSection, formatToolResponse } from '../tools/format'

export class LlamaCppProvider implements LLMProvider {
  readonly name: string
  private endpoint: string

  constructor(endpoint: string, model: string) {
    this.endpoint = endpoint.replace(/\/$/, '')
    this.name = `llamacpp/${model}`
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages = this.formatMessages(req.messages, req.tools ?? [])

    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        stream: false,
        // Stop at tool_call close tag to prevent runaway generation
        stop: req.tools?.length ? ['</tool_call>'] : undefined,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`llama.cpp error: ${response.status} - ${error}`)
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>
      usage: { prompt_tokens: number; completion_tokens: number }
      model: string
    }

    let content = data.choices[0]?.message?.content ?? ''

    // If we stopped at </tool_call>, add the closing tag back
    if (req.tools?.length && content.includes('<tool_call>') && !content.includes('</tool_call>')) {
      content += '</tool_call>'
    }

    // Parse tool calls from response
    const { content: cleanContent, toolCalls } = parseToolCalls(content)

    return {
      content: cleanContent,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        input_tokens: data.usage?.prompt_tokens ?? 0,
        output_tokens: data.usage?.completion_tokens ?? 0,
      },
      model: data.model ?? this.name,
    }
  }

  /**
   * Format messages for Qwen3 chat template:
   * - Inject tools section into system prompt
   * - Convert tool role messages to user role with <tool_response> tags
   */
  private formatMessages(
    messages: ChatMessage[],
    tools: ChatRequest['tools']
  ): Array<{ role: string; content: string }> {
    const formatted: Array<{ role: string; content: string }> = []
    const toolsSection = tools?.length ? buildToolsSection(tools) : ''

    // Batch consecutive tool messages
    let pendingToolResponses: string[] = []

    const flushToolResponses = () => {
      if (pendingToolResponses.length > 0) {
        formatted.push({
          role: 'user',
          content: pendingToolResponses.join('\n'),
        })
        pendingToolResponses = []
      }
    }

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Append tools section to system prompt
        formatted.push({
          role: 'system',
          content: msg.content + toolsSection,
        })
      } else if (msg.role === 'tool') {
        // Batch tool responses (Qwen3 uses user role with <tool_response> tags)
        pendingToolResponses.push(formatToolResponse(msg.content))
      } else {
        // Flush any pending tool responses before non-tool message
        flushToolResponses()
        formatted.push({
          role: msg.role,
          content: msg.content,
        })
      }
    }

    // Flush remaining tool responses
    flushToolResponses()

    return formatted
  }
}

export function createLlamaCppProvider(endpoint: string, model: string): LLMProvider {
  return new LlamaCppProvider(endpoint, model)
}
