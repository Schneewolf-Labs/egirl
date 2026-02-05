import type { LLMProvider, ChatRequest, ChatResponse, ToolCall } from './types'

export class LlamaCppProvider implements LLMProvider {
  readonly name: string
  private endpoint: string

  constructor(endpoint: string, model: string) {
    this.endpoint = endpoint.replace(/\/$/, '')
    this.name = `llamacpp/${model}`
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: req.messages.map(m => ({
          role: m.role === 'tool' ? 'user' : m.role,
          content: m.content,
        })),
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        stream: false,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`llama.cpp error: ${response.status} - ${error}`)
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>
      usage: { prompt_tokens: number; completion_tokens: number }
      model: string
    }

    let tool_calls: ToolCall[] | undefined
    let content = data.choices[0]?.message?.content ?? ''

    // Parse tool calls from response if tools were provided
    if (req.tools && req.tools.length > 0) {
      const parsed = this.parseToolCalls(content)
      if (parsed.toolCalls.length > 0) {
        tool_calls = parsed.toolCalls
        content = parsed.content
      }
    }

    return {
      content,
      tool_calls,
      usage: {
        input_tokens: data.usage?.prompt_tokens ?? 0,
        output_tokens: data.usage?.completion_tokens ?? 0,
      },
      model: data.model ?? this.name,
    }
  }

  private parseToolCalls(content: string): { content: string; toolCalls: ToolCall[] } {
    const toolCalls: ToolCall[] = []

    // Look for JSON tool call format in code blocks
    const toolCallRegex = /```(?:json)?\s*(\{[\s\S]*?"name"\s*:\s*"[^"]+[\s\S]*?\})\s*```/g
    let match
    let cleanContent = content

    while ((match = toolCallRegex.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1])
        if (parsed.name && parsed.arguments) {
          toolCalls.push({
            id: `call_${toolCalls.length}`,
            name: parsed.name,
            arguments: parsed.arguments,
          })
          cleanContent = cleanContent.replace(match[0], '')
        }
      } catch {
        // Not valid JSON, skip
      }
    }

    return { content: cleanContent.trim(), toolCalls }
  }
}

export function createLlamaCppProvider(endpoint: string, model: string): LLMProvider {
  return new LlamaCppProvider(endpoint, model)
}
