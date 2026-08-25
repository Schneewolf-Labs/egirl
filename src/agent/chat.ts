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
import { log } from '../util/logger'
import { formatSummaryMessage } from './context-summarizer'
import { fitToContextWindow } from './context-window'
import { pruneMalformedCallPairs, toolsWithRequiredParams } from './history-hygiene'

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

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await provider.chat({
        messages,
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

      const errorMsg = error instanceof Error ? error.message : String(error)
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
}): Promise<{ response: ChatResponse; droppedMessages: ChatMessage[]; wasTrimmed: boolean }> {
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

  const fitResult = await fitToContextWindow(
    effectiveSystemPrompt,
    hygienic,
    tools,
    { contextLength },
    tokenizer,
  )

  // Defensive: hoist any stray system message out of the history instead of sending it inline.
  // Anything that appends one mid-conversation would otherwise resurrect the bug above, and a
  // 400 from a Jinja template is a very indirect way to discover that.
  const strays = fitResult.messages.filter((m) => m.role === 'system')
  const history = fitResult.messages.filter((m) => m.role !== 'system')
  if (strays.length) {
    log.warn('agent', `Hoisted ${strays.length} inline system message(s) into the system prompt`)
  }
  const fittedMessages: ChatMessage[] = [
    {
      role: 'system',
      content: [effectiveSystemPrompt, ...strays.map((m) => String(m.content))].join('\n\n'),
    },
    ...history,
  ]

  log.debug(
    'agent',
    `Sending ${fittedMessages.length} messages to ${provider.name} (budget: ${contextLength}t)`,
  )

  try {
    const response = await chatWithRetry({
      provider,
      messages: fittedMessages,
      tools,
      onToken: args.onToken,
      onThinkingToken: args.onThinkingToken,
      thinking: args.thinking,
      signal: args.signal,
      cacheSlot: args.cacheSlot,
    })
    return {
      response,
      droppedMessages: fitResult.droppedMessages,
      wasTrimmed: fitResult.wasTrimmed,
    }
  } catch (error) {
    if (!(error instanceof ContextSizeError)) throw error

    log.warn(
      'agent',
      `Server n_ctx=${error.contextSize} differs from config (${contextLength}). Retrimming.`,
    )

    const refitResult = await fitToContextWindow(
      effectiveSystemPrompt,
      hygienic,
      tools,
      { contextLength: error.contextSize },
      tokenizer,
    )

    // Same hoist as above — this retry path would otherwise reintroduce the inline system
    // message whenever the server's real n_ctx differs from the configured one.
    const retryStrays = refitResult.messages.filter((m) => m.role === 'system')
    const retryMessages: ChatMessage[] = [
      {
        role: 'system',
        content: [effectiveSystemPrompt, ...retryStrays.map((m) => String(m.content))].join('\n\n'),
      },
      ...refitResult.messages.filter((m) => m.role !== 'system'),
    ]

    const response = await chatWithRetry({
      provider,
      messages: retryMessages,
      tools,
      onToken: args.onToken,
      onThinkingToken: args.onThinkingToken,
      thinking: args.thinking,
      signal: args.signal,
      cacheSlot: args.cacheSlot,
    })
    return {
      response,
      droppedMessages: refitResult.droppedMessages,
      wasTrimmed: refitResult.wasTrimmed,
    }
  }
}
