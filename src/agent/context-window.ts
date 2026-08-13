import type { ChatMessage, Tokenizer, ToolDefinition } from '../providers/types'
import { log } from '../util/logger'

export interface ContextWindowConfig {
  contextLength: number
  reserveForOutput?: number // tokens to reserve for model response (default 2048)
  maxToolResultTokens?: number // max tokens per individual tool result (default 8000)
}

export interface FitResult {
  messages: ChatMessage[]
  droppedMessages: ChatMessage[] // messages that were trimmed from the front
  wasTrimmed: boolean
}

// ---------------------------------------------------------------------------
// Token counting — uses real tokenizer when available, estimation as fallback
// ---------------------------------------------------------------------------

/**
 * Estimate tokens for a string. Fallback when no tokenizer is available.
 * Uses chars/3.5 ratio (slightly conservative to avoid undercount).
 */
function estimateStringTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

/**
 * Count tokens for a string, preferring the real tokenizer when provided.
 */
async function countStringTokens(text: string, tokenizer?: Tokenizer): Promise<number> {
  if (tokenizer) return tokenizer.countTokens(text)
  return estimateStringTokens(text)
}

/**
 * Count tokens for a ChatMessage, using the tokenizer for text content
 * and falling back to estimation for structural overhead.
 */
async function countMessageTokens(message: ChatMessage, tokenizer?: Tokenizer): Promise<number> {
  // Per-message framing: role tag, special tokens, separators.
  // Template-dependent but ~7 tokens covers Qwen3/ChatML-style templates.
  let tokens = 7

  if (typeof message.content === 'string') {
    tokens += await countStringTokens(message.content, tokenizer)
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text') {
        tokens += await countStringTokens(part.text, tokenizer)
      } else if (part.type === 'image_url') {
        tokens += 1000 // rough estimate for vision tokens
      }
    }
  }

  if (message.tool_calls) {
    for (const call of message.tool_calls) {
      const callText = `${call.name}\n${JSON.stringify(call.arguments)}`
      tokens += await countStringTokens(callText, tokenizer)
      tokens += 15 // id + structural overhead
    }
  }

  if (message.tool_call_id) {
    tokens += 5
  }

  return tokens
}

/**
 * Count tokens for tool definitions (serialized into the prompt by the chat template).
 */
async function countToolDefinitionTokens(
  tools: ToolDefinition[],
  tokenizer?: Tokenizer,
): Promise<number> {
  if (tools.length === 0) return 0

  // Tokenize the full JSON representation — this is close to what the template serializes
  const toolsJson = JSON.stringify(
    tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
  )
  const contentTokens = await countStringTokens(toolsJson, tokenizer)
  // Add overhead for template wrapping around the tools block
  return contentTokens + 20
}

/**
 * Sync token estimation for a ChatMessage (no tokenizer).
 * Kept as a public API for routing heuristics and other sync callers.
 */
export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = 4

  if (typeof message.content === 'string') {
    tokens += estimateStringTokens(message.content)
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text') {
        tokens += estimateStringTokens(part.text)
      } else if (part.type === 'image_url') {
        tokens += 1000
      }
    }
  }

  if (message.tool_calls) {
    for (const call of message.tool_calls) {
      tokens += estimateStringTokens(call.name)
      tokens += estimateStringTokens(JSON.stringify(call.arguments))
      tokens += 15
    }
  }

  if (message.tool_call_id) {
    tokens += 10
  }

  return tokens
}

// ---------------------------------------------------------------------------
// Tool result truncation
// ---------------------------------------------------------------------------

/**
 * Truncate a tool result string synchronously using char-ratio estimation.
 * Used at ingestion time to prevent oversized results from bloating context.
 * Returns the original string if within budget, otherwise truncates.
 */
export function truncateToolResultSync(content: string, maxTokens: number): string {
  const estimatedTokens = estimateStringTokens(content)
  if (estimatedTokens <= maxTokens) return content

  const maxChars = Math.floor(maxTokens * 3.5)
  return `${content.slice(0, maxChars)}\n\n[Output truncated — ${estimatedTokens} estimated tokens exceeded ${maxTokens} token limit]`
}

/**
 * Truncate a single tool result message if it exceeds the token budget.
 */
async function truncateToolResult(
  message: ChatMessage,
  maxTokens: number,
  tokenizer?: Tokenizer,
): Promise<ChatMessage> {
  if (message.role !== 'tool' || typeof message.content !== 'string') {
    return message
  }

  const actual = await countStringTokens(message.content, tokenizer)
  if (actual <= maxTokens) {
    return message
  }

  // Binary-ish approach: estimate char cut point then verify with tokenizer
  let maxChars = Math.floor(maxTokens * 3.5)
  if (tokenizer && maxChars < message.content.length) {
    // Refine: tokenize the cut to verify we're under budget
    const cutContent = message.content.slice(0, maxChars)
    const cutTokens = await tokenizer.countTokens(cutContent)
    if (cutTokens > maxTokens) {
      // Over-shot — scale down proportionally
      maxChars = Math.floor(maxChars * (maxTokens / cutTokens) * 0.95)
    }
  }

  return {
    ...message,
    content: `${message.content.slice(0, maxChars)}\n\n[Output truncated to fit context window]`,
  }
}

// ---------------------------------------------------------------------------
// Message grouping
// ---------------------------------------------------------------------------

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
    const msg = messages[idx]
    if (!msg) break
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

// ---------------------------------------------------------------------------
// Main context window fitting
// ---------------------------------------------------------------------------

/**
 * Fit conversation messages into a context window budget.
 *
 * When a Tokenizer is provided, token counts come from the llama.cpp /tokenize
 * endpoint (with caching). Otherwise falls back to char-ratio estimation.
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
 * When messages are dropped, they are returned in `droppedMessages` so the
 * caller can summarize them for context compaction.
 */
export async function fitToContextWindow(
  systemPrompt: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  config: ContextWindowConfig,
  tokenizer?: Tokenizer,
): Promise<FitResult> {
  const { contextLength, reserveForOutput = 2048, maxToolResultTokens = 8000 } = config

  const systemTokens = (await countStringTokens(systemPrompt, tokenizer)) + 4
  const toolDefTokens = await countToolDefinitionTokens(tools, tokenizer)
  const budget = contextLength - reserveForOutput - systemTokens - toolDefTokens

  if (budget <= 0) {
    log.warn(
      'context-window',
      `System prompt (~${systemTokens}t) + tools (~${toolDefTokens}t) + reserve (${reserveForOutput}t) exceeds context (${contextLength}t)`,
    )
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const fallback = lastUser ? [lastUser] : messages.slice(-1)
    return { messages: fallback, droppedMessages: messages, wasTrimmed: true }
  }

  // Truncate oversized tool results (in parallel)
  const processed = await Promise.all(
    messages.map((msg) =>
      msg.role === 'tool' ? truncateToolResult(msg, maxToolResultTokens, tokenizer) : msg,
    ),
  )

  // Count tokens for all messages (in parallel)
  const tokenCounts = await Promise.all(processed.map((msg) => countMessageTokens(msg, tokenizer)))
  const totalTokens = tokenCounts.reduce((sum, t) => sum + t, 0)

  // Everything fits — no trimming needed
  if (totalTokens <= budget) {
    return { messages: processed, droppedMessages: [], wasTrimmed: false }
  }

  log.info(
    'context-window',
    `Trimming context: ~${totalTokens + systemTokens + toolDefTokens}t vs ${contextLength}t limit`,
  )

  const truncationNoticeTokens = 30
  const availableTokens = budget - truncationNoticeTokens

  const groups = buildMessageGroups(processed, tokenCounts)

  // Interior compaction strategy:
  // 1. Always protect the first group (first user message / task context)
  // 2. Keep the most recent groups that fit from the end
  // 3. The middle section gets dropped and summarized

  // Reserve the first group (first user message) if it fits
  const firstGroup = groups[0]
  let headTokens = 0
  let headGroupCount = 0

  if (firstGroup && firstGroup.tokens <= availableTokens * 0.3) {
    // Only protect head if it's ≤30% of budget — don't starve the tail
    headTokens = firstGroup.tokens
    headGroupCount = 1
  }

  // Walk backward through remaining groups, fitting what we can into the tail
  const tailGroups: MessageGroup[] = []
  let tailTokens = 0
  const tailBudget = availableTokens - headTokens

  for (let g = groups.length - 1; g >= headGroupCount; g--) {
    const group = groups[g]
    if (!group) continue
    if (tailTokens + group.tokens <= tailBudget) {
      tailGroups.unshift(group)
      tailTokens += group.tokens
    } else {
      break
    }
  }

  // A single oversized group at the end — a web_search returning ten results, a fetched page,
  // a long tool result — is bigger than the tail budget on its own, so the loop above breaks on
  // its first iteration and keeps *nothing recent*. The model is then left holding the first
  // user message plus a summary, with the turn it is supposed to answer deleted, and it
  // confabulates a new task. Observed: a research run made sixteen searches, compaction logged
  // "kept head + 0 tail groups", and the model replied by scaffolding an unrelated project.
  //
  // The most recent group is the one thing that must survive. Keep it even when it does not fit;
  // going over the soft budget is recoverable, losing the current turn is not.
  if (tailGroups.length === 0) {
    for (let g = groups.length - 1; g >= headGroupCount; g--) {
      const group = groups[g]
      if (group) {
        tailGroups.push(group)
        tailTokens += group.tokens
        break
      }
    }
  }

  // Collect fitted messages: head + tail (with middle dropped)
  const result: ChatMessage[] = []
  const keptGroupIndices = new Set<number>()

  // Add head groups
  for (let g = 0; g < headGroupCount; g++) {
    const group = groups[g]
    if (!group) continue
    keptGroupIndices.add(g)
    for (let j = group.startIdx; j <= group.endIdx; j++) {
      const msg = processed[j]
      if (msg) result.push(msg)
    }
  }

  // Add tail groups
  for (const group of tailGroups) {
    const gIdx = groups.indexOf(group)
    keptGroupIndices.add(gIdx)
    for (let j = group.startIdx; j <= group.endIdx; j++) {
      const msg = processed[j]
      if (msg) result.push(msg)
    }
  }

  // If we somehow fit nothing, include at least the last user message
  if (result.length === 0) {
    const lastUser = [...processed].reverse().find((m: ChatMessage) => m.role === 'user')
    if (lastUser) {
      result.push(lastUser)
    }
  }

  // Collect dropped messages from the middle (groups not in head or tail)
  const dropped: ChatMessage[] = []
  for (let g = 0; g < groups.length; g++) {
    if (keptGroupIndices.has(g)) continue
    const group = groups[g]
    if (!group) continue
    for (let j = group.startIdx; j <= group.endIdx; j++) {
      const msg = messages[j]
      if (msg) dropped.push(msg)
    }
  }

  const droppedCount = dropped.length
  if (droppedCount > 0) {
    log.info(
      'context-window',
      `Interior compaction: dropped ${droppedCount} middle messages, kept ${headGroupCount > 0 ? 'head + ' : ''}${tailGroups.length} tail groups`,
    )
    // Insert truncation notice between head and tail
    const insertIdx =
      headGroupCount > 0 ? (groups[0]?.endIdx ?? 0) - (groups[0]?.startIdx ?? 0) + 1 : 0
    result.splice(insertIdx, 0, {
      role: 'user',
      content: `[System notice: ${droppedCount} middle messages were summarized to fit context window. See conversation summary for details.]`,
    })
  }

  return { messages: result, droppedMessages: dropped, wasTrimmed: droppedCount > 0 }
}
