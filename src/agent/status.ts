import type { RuntimeConfig } from '../config'
import type { Tokenizer } from '../providers/types'
import type { AgentContext } from './context'
import { countMessageTokens } from './context-window'

export interface ContextStatus {
  contextLength: number
  systemPromptTokens: number
  messageCount: number
  messageTokens: number
  summaryTokens: number
  totalUsed: number
  available: number
  /** 0–1 fraction of context used */
  utilization: number
  hasSummary: boolean
  sessionId: string
}

/** Get a snapshot of the current context window usage */
export async function computeContextStatus(
  config: RuntimeConfig,
  tokenizer: Tokenizer,
  context: AgentContext,
): Promise<ContextStatus> {
  const contextLength = config.local.contextLength
  const systemTokens = await tokenizer.countTokens(context.systemPrompt)
  let messageTokens = 0
  // The context window's own counter: an attached image is IMAGE_TOKENS, not its base64 as text
  // (a 1.8 MB PNG read that way was 3.2M tokens, and /context said 9995% full).
  for (const msg of context.messages) messageTokens += await countMessageTokens(msg, tokenizer)
  const summaryTokens = context.conversationSummary
    ? await tokenizer.countTokens(context.conversationSummary)
    : 0
  const totalUsed = systemTokens + messageTokens + summaryTokens
  const reserveForOutput = 2048

  return {
    contextLength,
    systemPromptTokens: systemTokens,
    messageCount: context.messages.length,
    messageTokens,
    summaryTokens,
    totalUsed,
    available: contextLength - totalUsed - reserveForOutput,
    utilization: totalUsed / contextLength,
    hasSummary: !!context.conversationSummary,
    sessionId: context.sessionId,
  }
}
