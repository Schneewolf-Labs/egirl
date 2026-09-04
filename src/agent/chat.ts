import { classifyProviderError, isRetryable, retryDelay } from '../providers/error-classify'
import type {
  ChatMessage,
  ChatResponse,
  LLMProvider,
  ThinkingConfig,
  Tokenizer,
  ToolDefinition,
} from '../providers/types'
import { ContextSizeError } from '../providers/types'
import { errorMessage } from '../util/errors'
import { log } from '../util/logger'
import { formatSummaryMessage } from './context-summarizer'
import { fitToContextWindow } from './context-window'
import { buildHandoffRecord } from './handoff'
import { pruneMalformedCallPairs, toolsWithRequiredParams } from './history-hygiene'

const IMAGE_STRIPPED_MARKER =
  '[image omitted: this endpoint has no image support (no mmproj). Capture to a file and inspect it with shell tools instead.]'

/** Replace image content (data-URL strings and image_url parts) with a text marker. */
export function stripImageContent(messages: ChatMessage[]): {
  messages: ChatMessage[]
  changed: boolean
  count: number
} {
  let count = 0
  const out = messages.map((m) => {
    if (typeof m.content === 'string') {
      if (m.content.startsWith('data:') && m.content.includes(';base64,')) {
        count++
        return { ...m, content: IMAGE_STRIPPED_MARKER }
      }
      return m
    }
    if (Array.isArray(m.content)) {
      let touched = false
      const parts = m.content.map((p) => {
        if (p.type === 'image_url') {
          touched = true
          count++
          return { type: 'text' as const, text: IMAGE_STRIPPED_MARKER }
        }
        return p
      })
      if (touched) return { ...m, content: parts }
    }
    return m
  })
  return { messages: out, changed: count > 0, count }
}

/**
 * Call provider.chat with classified retry logic.
 * Retries on transient/rate-limit errors with appropriate backoff.
 * Fails fast on auth, billing, and other non-retryable errors.
 * ContextSizeError is always rethrown for the caller to handle.
 */
export async function chatWithRetry(args: {
  provider: LLMProvider
  messages: ChatMessage[]
  tools: ToolDefinition[]
  onToken?: (token: string) => void
  onThinkingToken?: (token: string) => void
  thinking?: ThinkingConfig
  signal?: AbortSignal
  maxRetries?: number
  cacheSlot?: number
}): Promise<ChatResponse> {
  const {
    provider,
    messages,
    tools,
    onToken,
    onThinkingToken,
    thinking,
    signal,
    cacheSlot,
    maxRetries = 2,
  } = args
  let lastError: unknown
  let sendMessages = messages

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await provider.chat({
        messages: sendMessages,
        tools,
        onToken,
        onThinkingToken,
        thinking,
        signal,
        cacheSlot,
      })
    } catch (error) {
      lastError = error
      if (error instanceof ContextSizeError) throw error
      if (signal?.aborted) throw error

      const errorMsg = errorMessage(error)

      // A text-only endpoint rejects the whole request when any message carries an image
      // ("image input is not supported ... you may need to provide the mmproj"). Retrying the
      // identical request can never succeed, and one stray screenshot in a persisted session
      // fails EVERY subsequent run of that session — observed as five straight instant
      // failures auto-pausing a healthy task. Strip the images to text markers and retry:
      // losing a picture is survivable, losing the whole conversation is not.
      if (/image input is not supported/i.test(errorMsg)) {
        const stripped = stripImageContent(sendMessages)
        if (stripped.changed) {
          log.warn(
            'agent',
            `Provider rejects image input — stripped ${stripped.count} image(s) to text markers and retrying`,
          )
          sendMessages = stripped.messages
          continue
        }
      }

      const errorKind = classifyProviderError(errorMsg)

      if (!isRetryable(errorKind) || attempt >= maxRetries) {
        log.warn('agent', `Provider error (${errorKind}): ${errorMsg}`)
        throw error
      }

      const delayMs = retryDelay(errorKind, attempt)
      log.warn(
        'agent',
        `Provider error (${errorKind}, attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms: ${errorMsg}`,
      )
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  throw lastError
}

/**
 * Fit messages to the context window, call the provider with retry,
 * and handle ContextSizeError by re-fitting with the server's actual n_ctx.
 *
 * Returns the response plus any messages that were dropped during fitting
 * (so the caller can trigger compaction).
 */
export async function chatWithContextWindow(args: {
  provider: LLMProvider
  systemPrompt: string
  messages: ChatMessage[]
  conversationSummary?: string
  tools: ToolDefinition[]
  contextLength: number
  tokenizer: Tokenizer
  onToken?: (token: string) => void
  onThinkingToken?: (token: string) => void
  thinking?: ThinkingConfig
  signal?: AbortSignal
  cacheSlot?: number
  /**
   * Context rollover instead of drop-and-summarize: when fitting would drop messages, the
   * whole history is replaced by one handoff record (see ./handoff.ts) and the request is
   * sent on that fresh window. The record comes back as `rollover` for the loop to adopt.
   */
  rollover?: { maxChars?: number }
}): Promise<{
  response: ChatResponse
  droppedMessages: ChatMessage[]
  wasTrimmed: boolean
  rollover?: ChatMessage
}> {
  const { provider, systemPrompt, messages, conversationSummary, tools, contextLength, tokenizer } =
    args

  // The conversation summary used to be injected as its own system message ahead of the history,
  // which put a system message at index 1. Qwen's chat template refuses that outright:
  //
  //   400 Unable to generate parser for this template
  //   raise_exception('System message must be at the beginning')
  //
  // so every long agentic run hard-failed the moment the summariser fired — precisely the
  // long-running sessions egirl exists for. Folding the summary into the leading system prompt
  // keeps the same information in the same position and makes it non-droppable during fitting,
  // which is what you want from a summary anyway.
  const effectiveSystemPrompt = conversationSummary
    ? `${systemPrompt}\n\n${String(formatSummaryMessage(conversationSummary).content)}`
    : systemPrompt

  // History hygiene before fitting: old empty-args call/response pairs are in-context
  // demonstrations of the malformed shape and actively teach the model to repeat it. Applied
  // per-request; the conversation store keeps the full record.
  const hygienic = pruneMalformedCallPairs(messages, toolsWithRequiredParams(tools))

  /** Fit the history to a window, rolling over instead of dropping when configured. */
  async function prepare(windowLength: number): Promise<{
    send: ChatMessage[]
    droppedMessages: ChatMessage[]
    wasTrimmed: boolean
    rollover?: ChatMessage
  }> {
    let fit = await fitToContextWindow(
      effectiveSystemPrompt,
      hygienic,
      tools,
      { contextLength: windowLength },
      tokenizer,
    )
    let droppedMessages = fit.droppedMessages
    let rollover: ChatMessage | undefined
    if (fit.wasTrimmed && args.rollover) {
      // Fitting would have dropped the middle and summarized it. Retire the whole window
      // instead: the record is built from the unfitted history (it needs the real tool
      // results, not the truncated ones) and refit only to guard against a pathological size.
      rollover = buildHandoffRecord(messages, { reason: 'auto', maxChars: args.rollover.maxChars })
      droppedMessages = messages
      fit = await fitToContextWindow(
        effectiveSystemPrompt,
        [rollover],
        tools,
        { contextLength: windowLength },
        tokenizer,
      )
    }

    // Defensive: hoist any stray system message out of the history instead of sending it
    // inline. Anything that appends one mid-conversation would otherwise resurrect the bug
    // above, and a 400 from a Jinja template is a very indirect way to discover that.
    const strays = fit.messages.filter((m) => m.role === 'system')
    const history = fit.messages.filter((m) => m.role !== 'system')
    if (strays.length) {
      log.warn('agent', `Hoisted ${strays.length} inline system message(s) into the system prompt`)
    }
    const send: ChatMessage[] = [
      {
        role: 'system',
        content: [effectiveSystemPrompt, ...strays.map((m) => String(m.content))].join('\n\n'),
      },
      ...history,
    ]
    return { send, droppedMessages, wasTrimmed: fit.wasTrimmed || rollover !== undefined, rollover }
  }

  const prepared = await prepare(contextLength)

  log.debug(
    'agent',
    `Sending ${prepared.send.length} messages to ${provider.name} (budget: ${contextLength}t)`,
  )

  try {
    const response = await chatWithRetry({
      provider,
      messages: prepared.send,
      tools,
      onToken: args.onToken,
      onThinkingToken: args.onThinkingToken,
      thinking: args.thinking,
      signal: args.signal,
      cacheSlot: args.cacheSlot,
    })
    return {
      response,
      droppedMessages: prepared.droppedMessages,
      wasTrimmed: prepared.wasTrimmed,
      rollover: prepared.rollover,
    }
  } catch (error) {
    if (!(error instanceof ContextSizeError)) throw error

    log.warn(
      'agent',
      `Server n_ctx=${error.contextSize} differs from config (${contextLength}). Retrimming.`,
    )

    // Same fit and hoist as above — this retry path would otherwise reintroduce the inline
    // system message whenever the server's real n_ctx differs from the configured one.
    const refit = await prepare(error.contextSize)

    const response = await chatWithRetry({
      provider,
      messages: refit.send,
      tools,
      onToken: args.onToken,
      onThinkingToken: args.onThinkingToken,
      thinking: args.thinking,
      signal: args.signal,
      cacheSlot: args.cacheSlot,
    })
    return {
      response,
      droppedMessages: refit.droppedMessages,
      wasTrimmed: refit.wasTrimmed,
      rollover: refit.rollover,
    }
  }
}
