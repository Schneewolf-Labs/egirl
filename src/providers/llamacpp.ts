import { parseToolCalls } from '../tools/format'
import { log } from '../util/logger'
import { formatMessagesForQwen3 } from './qwen3-format'
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentPart,
  LLMProvider,
  ThinkingConfig,
} from './types'
import { ContextSizeError } from './types'

/**
 * Extract `<think>...</think>` blocks from Qwen3 response content.
 * Returns the cleaned content and extracted thinking text.
 */
function extractThinkingTags(content: string): { content: string; thinking: string } {
  const thinkPattern = /<think>([\s\S]*?)<\/think>/g
  const thinkingParts: string[] = []
  const cleaned = content.replace(thinkPattern, (_match, inner: string) => {
    thinkingParts.push(inner.trim())
    return ''
  })
  return {
    content: cleaned.trim(),
    thinking: thinkingParts.join('\n\n'),
  }
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
    const messages = this.formatMessages(req.messages, req.thinking)

    // Format tools for llama.cpp (Qwen3 template expects this format)
    const tools = req.tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))

    const shouldStream = !!req.onToken
    const isThinkingEnabled = req.thinking && req.thinking.level !== 'off'

    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        tools: tools?.length ? tools : undefined,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        stream: shouldStream,
        // Qwen3 supports enable_thinking parameter via llama.cpp
        ...(isThinkingEnabled !== undefined && { enable_thinking: isThinkingEnabled }),
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
              errorJson.error.n_ctx ?? 0,
            )
          }
        } catch (e) {
          if (e instanceof ContextSizeError) throw e
          // JSON parse failed — fall through to generic error
        }
      }

      throw new Error(`llama.cpp error: ${response.status} - ${errorText}`)
    }

    let content: string
    let usage = { prompt_tokens: 0, completion_tokens: 0 }
    let model = this.name

    if (shouldStream && response.body) {
      const result = await this.readStream(
        response.body,
        req.onToken!,
        (req.tools?.length ?? 0) > 0,
      )
      content = result.content
      usage = result.usage
      model = result.model ?? this.name
    } else {
      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>
        usage: { prompt_tokens: number; completion_tokens: number }
        model: string
      }
      content = data.choices[0]?.message?.content ?? ''
      usage = data.usage ?? usage
      model = data.model ?? this.name
    }

    log.debug(
      'llamacpp',
      `Raw response (${content.length} chars): ${content.substring(0, 200)}${content.length > 200 ? '...' : ''}`,
    )

    // If generation was cut off mid-tool-call (e.g. by max_tokens), close the last tag
    if (req.tools?.length && content.includes('<tool_call>')) {
      const openCount = (content.match(/<tool_call>/g) || []).length
      const closeCount = (content.match(/<\/tool_call>/g) || []).length
      if (openCount > closeCount) {
        content += '\n</tool_call>'
      }
    }

    // Extract thinking blocks before parsing tool calls
    const { content: withoutThinking, thinking } = extractThinkingTags(content)

    // Parse tool calls from response
    const { content: cleanContent, toolCalls } = parseToolCalls(withoutThinking)

    if (toolCalls.length > 0) {
      log.debug(
        'llamacpp',
        `Parsed ${toolCalls.length} tool calls: ${toolCalls.map((tc) => tc.name).join(', ')}`,
      )
    }

    return {
      content: cleanContent,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
      },
      model,
      thinking: thinking || undefined,
    }
  }

  /**
   * Read an SSE stream from llama.cpp, emitting tokens via callback.
   * Buffers text near `<tool_call>` and `<think>` tags to avoid leaking raw XML to the user.
   */
  private async readStream(
    body: ReadableStream<Uint8Array>,
    onToken: (token: string) => void,
    hasTools: boolean,
  ): Promise<{
    content: string
    usage: { prompt_tokens: number; completion_tokens: number }
    model?: string
  }> {
    const decoder = new TextDecoder()
    const reader = body.getReader()

    let fullContent = ''
    let buffer = ''
    let inToolCall = false
    let inThink = false
    let usage = { prompt_tokens: 0, completion_tokens: 0 }
    let model: string | undefined

    const TOOL_OPEN = '<tool_call>'
    const THINK_OPEN = '<think>'
    const THINK_CLOSE = '</think>'

    const flushBuffer = () => {
      if (buffer) {
        onToken(buffer)
        buffer = ''
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue

          const data = trimmed.slice(6)
          if (data === '[DONE]') continue

          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>
              usage?: { prompt_tokens: number; completion_tokens: number }
              model?: string
            }

            if (parsed.usage) usage = parsed.usage
            if (parsed.model) model = parsed.model

            const token = parsed.choices?.[0]?.delta?.content
            if (!token) continue

            fullContent += token

            if (inToolCall) {
              continue
            }

            if (inThink) {
              // Check if the think block is closing
              buffer += token
              if (buffer.includes(THINK_CLOSE)) {
                inThink = false
                buffer = ''
              }
              continue
            }

            // Buffer tokens to detect <think> or <tool_call> tags
            buffer += token

            // Check for <think> tag
            const thinkIdx = buffer.indexOf(THINK_OPEN)
            if (thinkIdx !== -1) {
              const before = buffer.substring(0, thinkIdx)
              if (before) onToken(before)
              buffer = ''
              inThink = true
              continue
            }

            if (hasTools) {
              const openIdx = buffer.indexOf(TOOL_OPEN)
              if (openIdx !== -1) {
                const before = buffer.substring(0, openIdx)
                if (before) onToken(before)
                buffer = ''
                inToolCall = true
              } else {
                // Check partial matches against both tags
                const toolPartial = this.findPartialMatchLength(buffer, TOOL_OPEN)
                const thinkPartial = this.findPartialMatchLength(buffer, THINK_OPEN)
                const maxPartial = Math.max(toolPartial, thinkPartial)
                if (maxPartial > 0) {
                  onToken(buffer.substring(0, buffer.length - maxPartial))
                  buffer = buffer.substring(buffer.length - maxPartial)
                } else {
                  flushBuffer()
                }
              }
            } else {
              // No tools — only need to buffer for <think> tags
              const thinkPartial = this.findPartialMatchLength(buffer, THINK_OPEN)
              if (thinkPartial > 0) {
                onToken(buffer.substring(0, buffer.length - thinkPartial))
                buffer = buffer.substring(buffer.length - thinkPartial)
              } else {
                flushBuffer()
              }
            }
          } catch {
            // Invalid JSON line, skip
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    // Flush any remaining buffer (not inside a tag)
    if (!inToolCall && !inThink && buffer) {
      onToken(buffer)
    }

    return { content: fullContent, usage, model }
  }

  /**
   * Check how many trailing characters of `text` could be the start of `pattern`.
   */
  private findPartialMatchLength(text: string, pattern: string): number {
    for (let len = Math.min(text.length, pattern.length - 1); len > 0; len--) {
      if (text.endsWith(pattern.substring(0, len))) {
        return len
      }
    }
    return 0
  }

  private formatMessages(messages: ChatMessage[], thinking?: ThinkingConfig): FormattedMessage[] {
    const formatted = formatMessagesForQwen3(messages)

    // Qwen3 uses /think and /no_think tags to control thinking mode.
    // Prepend the directive to the first user message content.
    if (thinking) {
      const directive = thinking.level !== 'off' ? '/think' : '/no_think'
      for (const msg of formatted) {
        if (msg.role === 'user' && typeof msg.content === 'string') {
          msg.content = `${directive}\n${msg.content}`
          break
        }
      }
    }

    return formatted
  }
}

export function createLlamaCppProvider(endpoint: string, model: string): LLMProvider {
  return new LlamaCppProvider(endpoint, model)
}
