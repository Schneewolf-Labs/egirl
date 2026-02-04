import type { LLMProvider, ChatRequest, ChatResponse, ChatStreamChunk, ToolCall } from '../types'

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OllamaToolCall[]
}

interface OllamaToolCall {
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

interface OllamaTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

interface OllamaChatRequest {
  model: string
  messages: OllamaMessage[]
  tools?: OllamaTool[]
  stream?: boolean
  options?: {
    temperature?: number
    num_predict?: number
  }
}

interface OllamaChatResponse {
  model: string
  message: {
    role: 'assistant'
    content: string
    tool_calls?: OllamaToolCall[]
  }
  done: boolean
  eval_count?: number
  prompt_eval_count?: number
}

export class OllamaProvider implements LLMProvider {
  name: string
  type: 'local' = 'local'
  private endpoint: string
  private model: string

  constructor(endpoint: string, model: string) {
    this.endpoint = endpoint.replace(/\/$/, '')
    this.model = model
    this.name = `ollama/${model}`
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const ollamaRequest: OllamaChatRequest = {
      model: this.model,
      messages: request.messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls && {
          tool_calls: m.toolCalls.map(tc => ({
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        }),
      })),
      stream: false,
      options: {
        temperature: request.temperature,
        num_predict: request.maxTokens,
      },
    }

    if (request.tools && request.tools.length > 0) {
      ollamaRequest.tools = request.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }

    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ollamaRequest),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Ollama error: ${response.status} - ${error}`)
    }

    const data = await response.json() as OllamaChatResponse

    const toolCalls: ToolCall[] | undefined = data.message.tool_calls?.map((tc, i) => ({
      id: `call_${i}`,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }))

    return {
      content: data.message.content,
      toolCalls,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
      model: data.model,
      provider: 'local',
    }
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const ollamaRequest: OllamaChatRequest = {
      model: this.model,
      messages: request.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      stream: true,
      options: {
        temperature: request.temperature,
        num_predict: request.maxTokens,
      },
    }

    if (request.tools && request.tools.length > 0) {
      ollamaRequest.tools = request.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }

    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ollamaRequest),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Ollama error: ${response.status} - ${error}`)
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
        if (!line.trim()) continue
        const data = JSON.parse(line) as OllamaChatResponse

        if (data.message?.content) {
          yield { type: 'content', content: data.message.content }
        }

        if (data.message?.tool_calls) {
          for (const tc of data.message.tool_calls) {
            yield {
              type: 'tool_call',
              toolCall: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            }
          }
        }

        if (data.done) {
          yield {
            type: 'done',
            usage: {
              inputTokens: data.prompt_eval_count ?? 0,
              outputTokens: data.eval_count ?? 0,
            },
          }
        }
      }
    }
  }
}

export function createOllamaProvider(endpoint: string, model: string): LLMProvider {
  return new OllamaProvider(endpoint, model)
}
