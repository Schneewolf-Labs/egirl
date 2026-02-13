import type { ChatMessage, ContentPart, ToolDefinition } from '../providers/types'
import { log } from '../util/logger'

export interface ContextWindowConfig {
  contextLength: number
  reserveForOutput?: number       // tokens to reserve for model response (default 2048)
  maxToolResultTokens?: number    // max tokens per individual tool result (default 8000)
}

/**
 * Estimate tokens for a string.
 * Uses chars/3.5 ratio (slightly conservative to avoid undercount).
 */
function estimateStringTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

/**
 * Estimate token count for a single ChatMessage including content, tool calls, and structure.
 */
export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = 4  // message framing (role, separators)

  if (typeof message.content === 'string') {
    tokens += estimateStringTokens(message.content)
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text') {
        tokens += estimateStringTokens(part.text)
      } else if (part.type === 'image_url') {
        tokens += 1000  // rough estimate for vision tokens
      }
    }
  }

  if (message.tool_calls) {
    for (const call of message.tool_calls) {
      tokens += estimateStringTokens(call.name)
      tokens += estimateStringTokens(JSON.stringify(call.arguments))
      tokens += 15  // id + structural overhead
    }
  }

  if (message.tool_call_id) {
    tokens += 10
  }

  return tokens
}

/**
 * Estimate tokens consumed by tool definitions in the request.
 * These get serialized into the prompt by the chat template.
 */
function estimateToolDefinitionTokens(tools: ToolDefinition[]): number {
  let tokens = 0
  for (const tool of tools) {
    tokens += estimateStringTokens(tool.name)
    tokens += estimateStringTokens(tool.description)
    tokens += estimateStringTokens(JSON.stringify(tool.parameters))
    tokens += 20  // per-tool structural overhead
  }
  return tokens
}

/**
 * Truncate a single tool result message if it exceeds the token budget.
 */
function truncateToolResult(message: ChatMessage, maxTokens: number): ChatMessage {
  if (message.role !== 'tool' || typeof message.content !== 'string') {
    return message
  }

  if (estimateStringTokens(message.content) <= maxTokens) {
    return message
  }

  const maxChars = Math.floor(maxTokens * 3.5)
  return {
    ...message,
    content: message.content.slice(0, maxChars) + '\n\n[Output truncated to fit context window]',
  }
}

interface MessageGroup {
  startIdx: number
  endIdx: number
  tokens: number
}

/**
 * Build groups of messages that must stay together.
 *
 * An assistant message with tool_calls is grouped with all immediately
 * following tool result messages. Everything else is its own group.
 */
function buildMessageGroups(messages: ChatMessage[], tokenCounts: number[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  let idx = 0

  while (idx < messages.length) {
    const msg = messages[idx]!
    const msgTokens = tokenCounts[idx] ?? 0

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      let groupEnd = idx + 1
      let groupTokens = msgTokens

      while (groupEnd < messages.length && messages[groupEnd]?.role === 'tool') {
        groupTokens += tokenCounts[groupEnd] ?? 0
        groupEnd++
      }

      groups.push({ startIdx: idx, endIdx: groupEnd - 1, tokens: groupTokens })
      idx = groupEnd
    } else {
      groups.push({ startIdx: idx, endIdx: idx, tokens: msgTokens })
      idx++
    }
  }

  return groups
}

/**
 * Fit conversation messages into a context window budget.
 *
 * Strategy:
 * 1. Calculate token budget after system prompt, tool definitions, and output reserve
 * 2. Truncate oversized individual tool results
 * 3. Group tool-calling assistant messages with their tool results
 * 4. Sliding window from the end — keep the most recent groups that fit
 * 5. Insert a truncation notice when older messages are dropped
 *
 * Returns the fitted message array (without system prompt — caller prepends that).
 *
 * Extensible: future versions can summarize dropped messages, score importance,
 * or inject RAG-retrieved context into the truncation notice.
 */
export function fitToContextWindow(
  systemPrompt: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  config: ContextWindowConfig
): ChatMessage[] {
  const {
    contextLength,
    reserveForOutput = 2048,
    maxToolResultTokens = 8000,
  } = config

  const systemTokens = estimateStringTokens(systemPrompt) + 4
  const toolDefTokens = estimateToolDefinitionTokens(tools)
  const budget = contextLength - reserveForOutput - systemTokens - toolDefTokens

  if (budget <= 0) {
    log.warn(
      'context-window',
      `System prompt (~${systemTokens}t) + tools (~${toolDefTokens}t) + reserve (${reserveForOutput}t) exceeds context (${contextLength}t)`
    )
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    return lastUser ? [lastUser] : messages.slice(-1)
  }

  // Truncate oversized tool results
  const processed = messages.map(msg =>
    msg.role === 'tool' ? truncateToolResult(msg, maxToolResultTokens) : msg
  )

  const tokenCounts = processed.map(estimateMessageTokens)
  const totalTokens = tokenCounts.reduce((sum, t) => sum + t, 0)

  // Everything fits — no trimming needed
  if (totalTokens <= budget) {
    return processed
  }

  log.info(
    'context-window',
    `Trimming context: ~${totalTokens + systemTokens + toolDefTokens}t vs ${contextLength}t limit`
  )

  const truncationNoticeTokens = 30
  const availableTokens = budget - truncationNoticeTokens

  const groups = buildMessageGroups(processed, tokenCounts)

  // Walk backward through groups, fitting what we can
  const fittedGroups: MessageGroup[] = []
  let usedTokens = 0

  for (let g = groups.length - 1; g >= 0; g--) {
    const group = groups[g]!
    if (usedTokens + group.tokens <= availableTokens) {
      fittedGroups.unshift(group)
      usedTokens += group.tokens
    } else {
      break
    }
  }

  // Collect fitted messages
  const result: ChatMessage[] = []
  for (const group of fittedGroups) {
    for (let j = group.startIdx; j <= group.endIdx; j++) {
      const msg = processed[j]
      if (msg) result.push(msg)
    }
  }

  // If we somehow fit nothing, include at least the last user message
  if (result.length === 0) {
    const lastUser = [...processed].reverse().find(m => m.role === 'user')
    if (lastUser) {
      result.push(lastUser)
    }
  }

  const droppedCount = messages.length - result.length
  if (droppedCount > 0) {
    log.info('context-window', `Dropped ${droppedCount} older messages, kept ${result.length}`)
    result.unshift({
      role: 'system',
      content: `[Earlier conversation (${droppedCount} messages) was trimmed to fit context window.]`,
    })
  }

  return result
}
