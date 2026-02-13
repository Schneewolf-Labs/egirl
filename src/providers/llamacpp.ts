import type { LLMProvider, ChatRequest, ChatResponse, ChatMessage, ContentPart, Tokenizer } from './types'
import { ContextSizeError } from './types'
import { parseToolCalls } from '../tools/format'
import { log } from '../util/logger'

const TOKENIZE_TIMEOUT_MS = 5_000
const MAX_CACHED_CONTENT_LENGTH = 100_000
const MAX_CACHE_ENTRIES = 2048

/**
 * Tokenizer backed by llama.cpp's /tokenize endpoint.
 * Caches results by content string so repeated calls (system prompt, tool defs,
 * unchanged messages between turns) are free.
 * Falls back to char-ratio estimation on network/server errors.
 */
export class LlamaCppTokenizer implements Tokenizer {
  private endpoint: string
  private cache = new Map<string, number>()

  constructor(endpoint: string) {
    this.endpoint = endpoint.replace(/\/$/, '')
  }

  async countTokens(text: string): Promise<number> {
    const cached = this.cache.get(text)
    if (cached !== undefined) return cached

    try {
      const response = await fetch(`${this.endpoint}/tokenize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, add_special: false }),
        signal: AbortSignal.timeout(TOKENIZE_TIMEOUT_MS),
      })

      if (!response.ok) {
        log.debug('tokenizer', `tokenize endpoint returned ${response.status}, falling back to estimate`)
        return Math.ceil(text.length / 3.5)
      }

      const data = (await response.json()) as { tokens: number[] }
      const count = data.tokens.length

      // Cache if content isn't huge (avoids holding large strings as map keys)
      if (text.length <= MAX_CACHED_CONTENT_LENGTH) {
        if (this.cache.size >= MAX_CACHE_ENTRIES) {
          const firstKey = this.cache.keys().next().value
          if (firstKey !== undefined) this.cache.delete(firstKey)
        }
        this.cache.set(text, count)
      }

      return count
    } catch (error) {
      log.debug('tokenizer', 'tokenize request failed, falling back to estimate:', error)
      return Math.ceil(text.length / 3.5)
    }
  }
}

export function createLlamaCppTokenizer(endpoint: string): Tokenizer {
  return new LlamaCppTokenizer(endpoint)
}

type FormattedContent = string | ContentPart[]
type FormattedMessage = { role: string; content: FormattedContent }

export interface LlamaCppCapabilities {
  multimodal: boolean
  toolUse: boolean
}

export class LlamaCppProvider implements LLMProvider {
  readonly name: string
  private endpoint: string
  private capabilities: LlamaCppCapabilities | null = null

  constructor(endpoint: string, model: string) {
    this.endpoint = endpoint.replace(/\/$/, '')
    this.name = `llamacpp/${model}`
  }

  /**
   * Check server capabilities (multimodal, tool use, etc.)
   */
  async getCapabilities(): Promise<LlamaCppCapabilities> {
    if (this.capabilities) return this.capabilities

    try {
      const response = await fetch(`${this.endpoint}/v1/models`)
      if (!response.ok) {
        return { multimodal: false, toolUse: false }
      }

      const data = (await response.json()) as {
        data: Array<{ multimodal?: boolean; tool_use?: boolean }>
      }

      const model = data.data[0]
      this.capabilities = {
        multimodal: model?.multimodal ?? false,
        toolUse: model?.tool_use ?? false,
      }

      return this.capabilities
    } catch {
      return { multimodal: false, toolUse: false }
    }
  }

  /**
   * Check if server supports multimodal input
   */
  async supportsMultimodal(): Promise<boolean> {
    const caps = await this.getCapabilities()
    return caps.multimodal
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages = this.formatMessages(req.messages)

    // Format tools for llama.cpp (Qwen3 template expects this format)
    const tools = req.tools?.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))

    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        tools: tools?.length ? tools : undefined,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        stream: false,
        // Stop at tool_call close tag to prevent runaway generation
        stop: req.tools?.length ? ['</tool_call>'] : undefined,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()

      // Parse context size overflow errors so the agent loop can retry with trimmed context
      if (response.status === 400) {
        try {
          const errorJson = JSON.parse(errorText) as {
            error?: { type?: string; n_prompt_tokens?: number; n_ctx?: number }
          }
          if (errorJson.error?.type === 'exceed_context_size_error') {
            throw new ContextSizeError(
              errorJson.error.n_prompt_tokens ?? 0,
              errorJson.error.n_ctx ?? 0
            )
          }
        } catch (e) {
          if (e instanceof ContextSizeError) throw e
          // JSON parse failed — fall through to generic error
        }
      }

      throw new Error(`llama.cpp error: ${response.status} - ${errorText}`)
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>
      usage: { prompt_tokens: number; completion_tokens: number }
      model: string
    }

    let content = data.choices[0]?.message?.content ?? ''

    log.debug('llamacpp', `Raw response (${content.length} chars): ${content.substring(0, 200)}${content.length > 200 ? '...' : ''}`)

    // If we stopped at </tool_call>, add the closing tag back
    if (req.tools?.length && content.includes('<tool_call>') && !content.includes('</tool_call>')) {
      content += '</tool_call>'
    }

    // Parse tool calls from response
    const { content: cleanContent, toolCalls } = parseToolCalls(content)

    if (toolCalls.length > 0) {
      log.debug('llamacpp', `Parsed ${toolCalls.length} tool calls: ${toolCalls.map(tc => tc.name).join(', ')}`)
    }

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
   * Format messages for Qwen3 chat template.
   * The template handles:
   * - Tools section in system prompt (via tools parameter)
   * - Tool role messages converted to user role with <tool_response> tags
   * - Multimodal content (images/videos)
   *
   * We only need to handle special cases like image tool results.
   */
  private formatMessages(messages: ChatMessage[]): FormattedMessage[] {
    const formatted: FormattedMessage[] = []

    for (const msg of messages) {
      if (msg.role === 'tool') {
        const textContent = this.getTextContent(msg.content)

        // Check if this is an image result (base64 data URL)
        // For images, we need to pass multimodal content
        if (textContent.startsWith('data:image/')) {
          formatted.push({
            role: 'tool',
            content: [
              { type: 'text', text: 'Screenshot captured' },
              { type: 'image_url', image_url: { url: textContent } },
            ],
          })
        } else {
          formatted.push({
            role: msg.role,
            content: textContent,
          })
        }
      } else if (Array.isArray(msg.content)) {
        // Multimodal message, pass through
        formatted.push({
          role: msg.role,
          content: msg.content,
        })
      } else {
        // Regular text message
        formatted.push({
          role: msg.role,
          content: msg.content,
        })
      }
    }

    return formatted
  }

  /**
   * Extract text content from string or ContentPart array
   */
  private getTextContent(content: string | ContentPart[]): string {
    if (typeof content === 'string') {
      return content
    }

    return content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
  }
}

export function createLlamaCppProvider(endpoint: string, model: string): LLMProvider {
  return new LlamaCppProvider(endpoint, model)
}
