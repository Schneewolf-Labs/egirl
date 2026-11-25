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
  /**
   * Prompt tokens the provider reported for the most recent model call: what the model actually
   * saw. Undefined before the first call and after the context was cut (compaction, wipe).
   * `totalUsed` is the stored history instead, which still holds stale tool output that is only
   * cleared from the copy sent to the model, so it can read well past 100% while the model is not.
   */
  lastPromptTokens?: number
}

/**
 * How full the model's window is, for display: the last measured prompt when there is one,
 * the stored-history estimate otherwise. Every readout goes through this so they agree.
 */
export function windowFill(s: ContextStatus): {
  used: number
  fraction: number
  isMeasured: boolean
} {
  if (s.lastPromptTokens === undefined) {
    return { used: s.totalUsed, fraction: s.utilization, isMeasured: false }
  }
  const fraction = s.contextLength > 0 ? s.lastPromptTokens / s.contextLength : 0
  return { used: s.lastPromptTokens, fraction, isMeasured: true }
}

/** Get a snapshot of the current context window usage */
export async function computeContextStatus(
  config: RuntimeConfig,
  tokenizer: Tokenizer,
  context: AgentContext,
  lastPromptTokens?: number,
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
    ...(lastPromptTokens !== undefined && { lastPromptTokens }),
  }
}
