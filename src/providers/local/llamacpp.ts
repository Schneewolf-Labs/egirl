import type { LLMProvider, ChatRequest, ChatResponse, ChatStreamChunk, ToolCall } from '../types'

interface LlamaCppMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface LlamaCppRequest {
  messages: LlamaCppMessage[]
  temperature?: number
  n_predict?: number
  stream?: boolean
  grammar?: string
}

interface LlamaCppResponse {
  content: string
  model: string
  tokens_predicted: number
  tokens_evaluated: number
  stop: boolean
}

export class LlamaCppProvider implements LLMProvider {
  name: string
  type: 'local' = 'local'
  private endpoint: string
  private model: string

  constructor(endpoint: string, model: string) {
    this.endpoint = endpoint.replace(/\/$/, '')
    this.model = model
    this.name = `llamacpp/${model}`
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const llamaRequest: LlamaCppRequest = {
      messages: request.messages.map(m => ({
        role: m.role === 'tool' ? 'user' : m.role,
        content: m.content,
      })),
      temperature: request.temperature,
      n_predict: request.maxTokens,
      stream: false,
    }

    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(llamaRequest),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`llama.cpp error: ${response.status} - ${error}`)
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>
      usage: { prompt_tokens: number; completion_tokens: number }
    }

    // Parse tool calls from response content if tools were requested
    let toolCalls: ToolCall[] | undefined
    let content = data.choices[0]?.message?.content ?? ''

    if (request.tools && request.tools.length > 0) {
      const parsed = this.parseToolCalls(content)
      if (parsed.toolCalls.length > 0) {
        toolCalls = parsed.toolCalls
        content = parsed.content
      }
    }

    return {
      content,
      toolCalls,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      model: this.model,
      provider: 'local',
    }
  }

  private parseToolCalls(content: string): { content: string; toolCalls: ToolCall[] } {
    const toolCalls: ToolCall[] = []

    // Look for JSON tool call format: {"name": "tool_name", "arguments": {...}}
    const toolCallRegex = /```(?:json)?\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:\s*(\{[^}]+\})[\s\S]*?\}[\s\S]*?```/g
    let match
    let cleanContent = content

    while ((match = toolCallRegex.exec(content)) !== null) {
      try {
        const fullMatch = match[0]
        const jsonStr = fullMatch.replace(/```(?:json)?\s*/, '').replace(/\s*```$/, '')
        const parsed = JSON.parse(jsonStr)

        toolCalls.push({
          id: `call_${toolCalls.length}`,
          name: parsed.name,
          arguments: parsed.arguments,
        })

        cleanContent = cleanContent.replace(fullMatch, '')
      } catch {
        // Not valid JSON, skip
      }
    }

    return { content: cleanContent.trim(), toolCalls }
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const llamaRequest: LlamaCppRequest = {
      messages: request.messages.map(m => ({
        role: m.role === 'tool' ? 'user' : m.role,
        content: m.content,
      })),
      temperature: request.temperature,
      n_predict: request.maxTokens,
      stream: true,
    }

    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(llamaRequest),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`llama.cpp error: ${response.status} - ${error}`)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') {
          yield { type: 'done' }
          continue
        }

        try {
          const parsed = JSON.parse(data)
          const content = parsed.choices?.[0]?.delta?.content
          if (content) {
            yield { type: 'content', content }
          }
        } catch {
          // Invalid JSON, skip
        }
      }
    }
  }
}

export function createLlamaCppProvider(endpoint: string, model: string): LLMProvider {
  return new LlamaCppProvider(endpoint, model)
}
