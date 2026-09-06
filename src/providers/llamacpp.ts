import { isRepetitionDominated } from '../agent/repetition-guard'
import { parseToolCalls } from '../tools/format'
import { log } from '../util/logger'
import { toApiMessages } from './chat-format'
import { withReasoningFloor } from './reasoning-floors'
import type { ChatRequest, ChatResponse, LLMProvider, ToolCall, ToolDefinition } from './types'
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

/** A tool call as the server streams it: arguments arrive as JSON text, in fragments. */
interface WireToolCall {
  id?: string
  name: string
  arguments: string
}

/**
 * Turn the server's parsed tool calls into egirl's. The server already matched the model's
 * output against the tool grammar, so the arguments are JSON; a call whose arguments still do
 * not parse is rendered back into markup so the loop's stranded-call recovery handles it the
 * same way it handles a call the server never recognized.
 */
function resolveWireToolCalls(
  calls: WireToolCall[],
  content: string,
): { content: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = []
  let stranded = content
  calls.forEach((call, i) => {
    let args: unknown
    try {
      args = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments)
    } catch {
      args = undefined
    }
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      toolCalls.push({
        id: call.id || `call_${i}`,
        name: call.name,
        arguments: args as Record<string, unknown>,
      })
      return
    }
    stranded += `\n<tool_call>\n{"name": ${JSON.stringify(call.name)}, "arguments": ${call.arguments}}\n</tool_call>`
  })
  return { content: stranded, toolCalls }
}

export interface LlamaCppCapabilities {
  multimodal: boolean
  toolUse: boolean
}

/** Default stale-stream timeout in milliseconds (90 seconds) */
const DEFAULT_STALE_STREAM_TIMEOUT_MS = 90_000

/**
 * Bounds how many requests we have in flight against the local endpoint at once.
 *
 * `[local] max_concurrent` was config that nothing read: the agent loop stopped serializing
 * inference (SessionMutex now guards only the tool phase), so N sessions plus M background
 * tasks could all hit one endpoint together. That is fine against a server with N parallel
 * slots and actively harmful against one without: a serial engine (sabrewing's qwen35, or
 * llama.cpp with --parallel 1) queues the extras server-side, where they burn the
 * stale-stream timeout waiting for a slot rather than waiting politely here.
 *
 * Queuing client-side instead keeps the wait observable and makes the timeout mean what it
 * says — time without tokens from a request that is actually running.
 */
class Semaphore {
  private active = 0
  private waiters: (() => void)[] = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.limit <= 0) return () => {}
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    this.active++
    let released = false
    return () => {
      if (released) return // a double release would let the limit drift upward forever
      released = true
      this.active--
      this.waiters.shift()?.()
    }
  }
}

export class LlamaCppProvider implements LLMProvider {
  readonly name: string
  private endpoint: string
  private capabilities: LlamaCppCapabilities | null = null
  private staleStreamTimeoutMs: number
  private gate: Semaphore
  // Nothing set a temperature, so llama.cpp applied its own default (0.8). That is fine for
  // ordinary use and ruinous for measurement: two identical bench runs disagreed on 13 of 67
  // cases, a 19% flip rate, which is larger than any model difference worth detecting. Setting
  // this to 0 makes runs comparable.
  private defaultTemperature: number | undefined
  // Bearer token for a llama.cpp server started with --api-key. Empty for the usual open local
  // server; set when the operator model is shared (e.g. a keyed endpoint also serving a peer).
  private apiKey: string | undefined

  constructor(
    endpoint: string,
    model: string,
    staleStreamTimeoutMs?: number,
    maxConcurrent?: number,
    defaultTemperature?: number,
    apiKey?: string,
  ) {
    this.endpoint = endpoint.replace(/\/$/, '')
    this.name = `llamacpp/${model}`
    this.defaultTemperature = defaultTemperature
    this.apiKey = apiKey
    // Floored per model family: a reasoning model's thinking phase outlasts the chat-model
    // default, and the timer also spans prefill, which emits nothing on a large cold context.
    this.staleStreamTimeoutMs = withReasoningFloor(
      model,
      staleStreamTimeoutMs ?? DEFAULT_STALE_STREAM_TIMEOUT_MS,
    )
    // 0 or negative disables the limit, for a server with plenty of slots
    this.gate = new Semaphore(maxConcurrent ?? 0)
  }

  /**
   * Check server capabilities (multimodal, tool use, etc.)
   */
  async getCapabilities(): Promise<LlamaCppCapabilities> {
    if (this.capabilities) return this.capabilities

    try {
      const response = await fetch(`${this.endpoint}/v1/models`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      })
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
    const release = await this.gate.acquire()
    try {
      return await this.chatInner(req)
    } finally {
      release()
    }
  }

  private async chatInner(req: ChatRequest): Promise<ChatResponse> {
    // Tools go in the request as `tools`, and the server's chat template renders them in
    // whatever syntax this model was trained on. With --jinja the server also parses the
    // calls back out and constrains their arguments to the tool's schema, so a call arrives
    // as structured `tool_calls`; a server that only renders (no parser for the template)
    // leaves the markup in `content`, where parseToolCalls still finds it.
    const messages = toApiMessages(req.messages)
    const tools = req.tools?.length ? req.tools.map(toApiTool) : undefined

    // Always stream, even when the caller wants no live tokens (a background task passes no
    // onToken). Streaming is the ONLY path that carries the stale-stream timeout — with its
    // per-family reasoning floor — and resets it on both content AND reasoning_content deltas,
    // so a multi-minute thinking phase isn't mistaken for a hang. It also keeps response chunks
    // flowing, so the fetch's own body-timeout never fires mid-generation. The non-streaming
    // path had neither: a long reasoning generation on a task run (no onToken) aborted with
    // "The operation timed out" the moment it outran the fetch default, and stale_stream_timeout
    // never applied. The assembled result is identical; callers with no onToken get a no-op.
    const shouldStream = true
    const isThinkingEnabled = req.thinking && req.thinking.level !== 'off'

    // Bun's fetch has a built-in 300s timeout that fires before our own stale-stream and
    // abort machinery. On a single-slot server (-np 1), a request queued behind another
    // consumer's long generation legitimately waits longer than that for its first byte —
    // observed as periodic "The operation timed out" transient retries once the review fork
    // began sharing the operator endpoint. Our own timeouts govern; Bun's must not.
    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      // @ts-expect-error Bun extension: disable fetch's built-in timeout
      timeout: false,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
      },
      signal: req.signal,
      body: JSON.stringify({
        messages,
        // An agent turn routinely issues several calls at once; without this the server's
        // tool grammar stops the model after one.
        ...(tools && { tools, parallel_tool_calls: true }),
        temperature: req.temperature ?? this.defaultTemperature,
        max_tokens: req.max_tokens,
        stream: shouldStream,
        // A streamed response carries no usage unless it's explicitly requested — without this
        // the final chunk omits token counts and every streamed turn reports output_tokens: 0,
        // which throws off the token-budget and context-pressure accounting downstream. The
        // non-streaming path got usage for free in its response body.
        ...(shouldStream && { stream_options: { include_usage: true } }),
        // The template variable Qwen3-class templates read. llama.cpp only passes template
        // variables from chat_template_kwargs; a top-level enable_thinking is silently ignored,
        // and the template's default is thinking ON -- so `off` was never off. Verified against
        // /apply-template: only this form renders the closed `<think>\n\n</think>` block.
        ...(isThinkingEnabled !== undefined && {
          chat_template_kwargs: { enable_thinking: isThinkingEnabled },
        }),
        // Servers with per-slot prefix caching (sabrewing) reuse this conversation's
        // already-prefilled context. Ignored by servers that don't implement it.
        ...(req.cacheSlot !== undefined && { cache_slot: req.cacheSlot }),
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()

      // Parse context size overflow errors so the agent loop can retry with trimmed context
      if (response.status === 400) {
        try {
          const errorJson = JSON.parse(errorText) as {
            error?: { type?: string; message?: string; n_prompt_tokens?: number; n_ctx?: number }
          }
          if (errorJson.error?.type === 'exceed_context_size_error') {
            throw new ContextSizeError(
              errorJson.error.n_prompt_tokens ?? 0,
              errorJson.error.n_ctx ?? 0,
            )
          }
          // Newer llama.cpp builds report the same overflow as message text with a generic
          // type. Missing it here classified the error as unknown and skipped the retrim
          // path entirely — the task failed instead of refitting to the server's real n_ctx.
          const m = errorJson.error?.message?.match(
            /Prompt \((\d+) tokens\) exceeds context size \((\d+) tokens\)/,
          )
          if (m?.[1] && m[2]) {
            throw new ContextSizeError(Number(m[1]), Number(m[2]))
          }
        } catch (e) {
          if (e instanceof ContextSizeError) throw e
          // JSON parse failed — fall through to generic error
        }
      }

      // A 400 from the chat template is about the *shape* of the conversation, and the shape is
      // gone by the time the error is read. Log enough to reconstruct it: which roles, in what
      // order, and whether a user turn the template would accept was actually present. Without
      // this a template rejection is unreproducible after the fact -- the conversation has moved
      // on, and replaying the stored one succeeds.
      if (response.status === 400 && /template|user query/i.test(errorText)) {
        const roles = messages.map((m) => m.role)
        // Describe every user turn precisely. "0 acceptable" has at least three causes that
        // look identical in a count -- an empty turn, content that is not a string, and no
        // user turn at all -- and guessing between them from the outside does not work.
        const userTurns = messages
          .filter((m) => m.role === 'user')
          .map((m) => {
            if (typeof m.content !== 'string') return `non-string(${typeof m.content})`
            return `query:${JSON.stringify(m.content.trim().slice(0, 60))}`
          })
        log.error(
          'llamacpp',
          `Template rejected a ${messages.length}-message conversation. ` +
            `Roles: ${roles.join(',')}. User turns: ${userTurns.join(' | ') || '(none)'}`,
        )
      }

      throw new Error(`llama.cpp error: ${response.status} - ${errorText}`)
    }

    let content: string
    // Reasoning delivered out-of-band in `reasoning_content` rather than as inline `<think>`
    // tags. Empty when the server inlines it; `extractThinkingTags` handles that case below.
    let reasoning = ''
    let usage = { prompt_tokens: 0, completion_tokens: 0 }
    let model = this.name
    let finish_reason: string | undefined
    // Calls the server parsed out of the generation itself. Empty when the server only
    // renders the template and leaves the markup in `content`.
    let wireToolCalls: WireToolCall[] = []

    if (shouldStream && response.body) {
      const result = await this.readStream(
        response.body,
        req.onToken ?? (() => {}),
        tools !== undefined,
        req.onThinkingToken,
      )
      content = result.content
      reasoning = result.reasoning
      usage = result.usage
      model = result.model ?? this.name
      finish_reason = result.finish_reason
      wireToolCalls = result.toolCalls
    } else {
      const data = (await response.json()) as {
        choices: Array<{
          message: {
            content: string | null
            reasoning_content?: string
            reasoning?: string
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
          }
          finish_reason?: string
        }>
        usage: { prompt_tokens: number; completion_tokens: number }
        model: string
      }
      content = data.choices[0]?.message?.content ?? ''
      wireToolCalls = (data.choices[0]?.message?.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function?.name ?? '',
        arguments: tc.function?.arguments ?? '',
      }))
      // llama.cpp calls this reasoning_content; vLLM calls the identical field reasoning.
      reasoning =
        data.choices[0]?.message?.reasoning_content ?? data.choices[0]?.message?.reasoning ?? ''
      usage = data.usage ?? usage
      model = data.model ?? this.name
      finish_reason = data.choices[0]?.finish_reason ?? undefined
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

    // Server-parsed calls first, then anything left as markup in the content. Both can be
    // present at once: a server whose parser stops at the first call, or a model that wrote
    // one call in the grammar and a second one free-hand after it.
    const structured = resolveWireToolCalls(wireToolCalls, withoutThinking)
    const parsed = parseToolCalls(structured.content)
    const cleanContent = parsed.content
    const toolCalls = [...structured.toolCalls, ...parsed.toolCalls].map((tc, i) => ({
      ...tc,
      // Ids must be unique within the turn: the tool runner keys results on them.
      id: tc.id || `call_${i}`,
    }))

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
      // Inline tags win when present; `reasoning` covers servers that split it into its own
      // field, where extractThinkingTags has nothing to find.
      thinking: thinking || reasoning || undefined,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : (finish_reason ?? 'stop'),
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
    onThinkingToken: (token: string) => void = () => {},
  ): Promise<{
    content: string
    reasoning: string
    usage: { prompt_tokens: number; completion_tokens: number }
    model?: string
    finish_reason?: string
    toolCalls: WireToolCall[]
  }> {
    const decoder = new TextDecoder()
    const reader = body.getReader()

    let fullContent = ''
    let fullReasoning = ''
    // Streamed tool calls arrive as fragments keyed by index: the first carries the id and
    // name, the rest append to the arguments string.
    const toolCalls: WireToolCall[] = []
    let buffer = ''
    let inToolCall = false
    let inThink = false
    // Live death-spiral guard. A reasoning model can loop forever without ever emitting a final
    // answer, so the agent loop's post-response spiral check never runs and only the stale
    // timeout stops it — minutes of wasted compute per spiral. Scan the accumulating reasoning
    // on a cadence and stop generating the moment it is repetition-dominated. The partial
    // reasoning is still returned, so the agent loop's own isReasoningLooping classifies the run
    // as a spiral (an abort, not a retry) — this only makes the detection early, not different.
    let spiralAborted = false
    let lastSpiralScanLen = 0
    const SPIRAL_SCAN_INTERVAL = 2000
    let usage = { prompt_tokens: 0, completion_tokens: 0 }
    let model: string | undefined
    let finish_reason: string | undefined

    // Stale-stream detection: abort if no new content arrives within timeout
    let staleTimer: ReturnType<typeof setTimeout> | null = null
    let staleAborted = false
    const resetStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer)
      staleTimer = setTimeout(() => {
        staleAborted = true
        log.warn(
          'llamacpp',
          `Stream stale for ${this.staleStreamTimeoutMs}ms — aborting generation`,
        )
        reader.cancel().catch(() => {})
      }, this.staleStreamTimeoutMs)
    }
    resetStaleTimer()

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
              choices?: Array<{
                delta?: {
                  content?: string | null
                  reasoning_content?: string
                  reasoning?: string
                  tool_calls?: Array<{
                    index?: number
                    id?: string
                    function?: { name?: string; arguments?: string }
                  }>
                }
                finish_reason?: string | null
              }>
              usage?: { prompt_tokens: number; completion_tokens: number }
              model?: string
            }

            if (parsed.usage) usage = parsed.usage
            if (parsed.model) model = parsed.model
            const chunkFinish = parsed.choices?.[0]?.finish_reason
            if (chunkFinish) finish_reason = chunkFinish

            for (const delta of parsed.choices?.[0]?.delta?.tool_calls ?? []) {
              // A fragment without an index (some servers omit it) starts a new call when it
              // carries an id and otherwise continues the current one.
              const index =
                delta.index ?? (delta.id ? toolCalls.length : Math.max(toolCalls.length - 1, 0))
              const call = toolCalls[index] ?? { name: '', arguments: '' }
              if (delta.id) call.id = delta.id
              if (delta.function?.name) call.name += delta.function.name
              if (delta.function?.arguments) call.arguments += delta.function.arguments
              toolCalls[index] = call
              // The model is producing a call, which is progress even though no content token
              // shows for it.
              resetStaleTimer()
            }

            // Servers running `--reasoning-format deepseek` strip `<think>` out of the content
            // and stream it here instead. Those deltas are still the model working, so they have
            // to reset the stale timer: a reasoning model can deliberate for minutes before it
            // emits a single content token, and treating that silence as a hang aborts the
            // generation just as it was about to answer.
            // vLLM names this delta `reasoning`; llama.cpp names it `reasoning_content`.
            // Missing the alias is not cosmetic: these deltas are what reset the stale
            // timer, and a model that reasons for hundreds of tokens before its first
            // content token would look like a hung stream and be aborted mid-thought.
            const reasoningToken =
              parsed.choices?.[0]?.delta?.reasoning_content ?? parsed.choices?.[0]?.delta?.reasoning
            if (reasoningToken) {
              fullReasoning += reasoningToken
              onThinkingToken(reasoningToken)
              resetStaleTimer()
              // Scan on a cadence, not every token — isRepetitionDominated walks a window and
              // needs enough text to be meaningful (it fails open on short input).
              if (fullReasoning.length - lastSpiralScanLen >= SPIRAL_SCAN_INTERVAL) {
                lastSpiralScanLen = fullReasoning.length
                if (isRepetitionDominated(fullReasoning)) {
                  spiralAborted = true
                  log.warn(
                    'llamacpp',
                    `Reasoning stream is looping (${fullReasoning.length} chars) — stopping generation`,
                  )
                  reader.cancel().catch(() => {})
                  break
                }
              }
            }

            const token = parsed.choices?.[0]?.delta?.content
            if (!token) continue

            fullContent += token
            resetStaleTimer()

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
        if (spiralAborted) break
      }
    } finally {
      if (staleTimer) clearTimeout(staleTimer)
      reader.releaseLock()
    }

    if (staleAborted) {
      finish_reason = 'length' // Treat stale abort like truncation so continuation retries kick in
    }

    // Flush any remaining buffer (not inside a tag)
    if (!inToolCall && !inThink && buffer) {
      onToken(buffer)
    }

    return {
      content: fullContent,
      reasoning: fullReasoning,
      usage,
      model,
      finish_reason,
      toolCalls: toolCalls.filter((c) => c.name !== ''),
    }
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
}

export function createLlamaCppProvider(
  endpoint: string,
  model: string,
  staleStreamTimeoutMs?: number,
  maxConcurrent?: number,
  defaultTemperature?: number,
  apiKey?: string,
): LLMProvider {
  return new LlamaCppProvider(
    endpoint,
    model,
    staleStreamTimeoutMs,
    maxConcurrent,
    defaultTemperature,
    apiKey,
  )
}

function toApiTool(tool: ToolDefinition): object {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }
}
