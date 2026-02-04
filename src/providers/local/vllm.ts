import type { LLMProvider, ChatRequest, ChatResponse, ChatStreamChunk, ToolCall } from '../types'

interface VLLMRequest {
  model: string
  messages: Array<{
    role: string
    content: string
  }>
  temperature?: number
  max_tokens?: number
  stream?: boolean
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: object
    }
  }>
}

interface VLLMResponse {
  id: string
  choices: Array<{
    message: {
      role: string
      content: string
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: {
          name: string
          arguments: string
        }
      }>
    }
    finish_reason: string
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export class VLLMProvider implements LLMProvider {
  name: string
  type: 'local' = 'local'
  private endpoint: string
  private model: string

  constructor(endpoint: string, model: string) {
    this.endpoint = endpoint.replace(/\/$/, '')
    this.model = model
    this.name = `vllm/${model}`
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const vllmRequest: VLLMRequest = {
      model: this.model,
      messages: request.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: false,
    }

    if (request.tools && request.tools.length > 0) {
      vllmRequest.tools = request.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }

    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vllmRequest),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`vLLM error: ${response.status} - ${error}`)
    }

    const data = await response.json() as VLLMResponse

    const choice = data.choices[0]
    const toolCalls: ToolCall[] | undefined = choice?.message?.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }))

    return {
      content: choice?.message?.content ?? '',
      toolCalls,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      model: this.model,
      provider: 'local',
    }
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const vllmRequest: VLLMRequest = {
      model: this.model,
      messages: request.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: true,
    }

    if (request.tools && request.tools.length > 0) {
      vllmRequest.tools = request.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }

    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vllmRequest),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`vLLM error: ${response.status} - ${error}`)
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
          const delta = parsed.choices?.[0]?.delta

          if (delta?.content) {
            yield { type: 'content', content: delta.content }
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              yield {
                type: 'tool_call',
                toolCall: {
                  id: tc.id,
                  name: tc.function?.name,
                  arguments: tc.function?.arguments ? JSON.parse(tc.function.arguments) : undefined,
                },
              }
            }
          }

          if (parsed.usage) {
            yield {
              type: 'done',
              usage: {
                inputTokens: parsed.usage.prompt_tokens ?? 0,
                outputTokens: parsed.usage.completion_tokens ?? 0,
              },
            }
          }
        } catch {
          // Invalid JSON, skip
        }
      }
    }
  }
}

export function createVLLMProvider(endpoint: string, model: string): LLMProvider {
  return new VLLMProvider(endpoint, model)
}
