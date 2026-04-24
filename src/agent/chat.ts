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
  thinking?: ThinkingConfig
  maxRetries?: number
}): Promise<ChatResponse> {
  const { provider, messages, tools, onToken, thinking, maxRetries = 2 } = args
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await provider.chat({ messages, tools, onToken, thinking })
    } catch (error) {
      lastError = error
      if (error instanceof ContextSizeError) throw error

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
  thinking?: ThinkingConfig
}): Promise<{ response: ChatResponse; droppedMessages: ChatMessage[]; wasTrimmed: boolean }> {
  const { provider, systemPrompt, messages, conversationSummary, tools, contextLength, tokenizer } =
    args

  const messagesForFitting = conversationSummary
    ? [formatSummaryMessage(conversationSummary), ...messages]
    : messages

  const fitResult = await fitToContextWindow(
    systemPrompt,
    messagesForFitting,
    tools,
    { contextLength },
    tokenizer,
  )

  const fittedMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...fitResult.messages,
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
      thinking: args.thinking,
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
      systemPrompt,
      messagesForFitting,
      tools,
      { contextLength: error.contextSize },
      tokenizer,
    )

    const retryMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...refitResult.messages,
    ]

    const response = await chatWithRetry({
      provider,
      messages: retryMessages,
      tools,
      onToken: args.onToken,
      thinking: args.thinking,
    })
    return {
      response,
      droppedMessages: refitResult.droppedMessages,
      wasTrimmed: refitResult.wasTrimmed,
    }
  }
}
