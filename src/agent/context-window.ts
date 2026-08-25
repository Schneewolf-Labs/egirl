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
/**
 * A tool result that is a data URL is an image, not prose.
 *
 * The screenshot tool returns `data:image/png;base64,...` -- 2.5MB of base64 for a 3440x1440
 * capture. Two things then went wrong. Counted as text it estimates ~730k tokens, and truncated
 * to the 8k tool-result budget it becomes 28k characters of base64 cut mid-stream, which
 * llama.cpp rejects with "Failed to load image or audio file". The screenshot tool could not
 * work in a real conversation at all; sending the identical image outside the agent succeeds.
 *
 * It is converted to an `image_url` part before it reaches the model, where it is already
 * budgeted at IMAGE_TOKENS, so the string form should never be measured or cut as text.
 */
export function isDataUrl(text: string): boolean {
  return text.startsWith('data:') && text.includes(';base64,')
}

/** Rough cost of one image once the provider converts it to an image_url part. */
export const IMAGE_TOKENS = 1000

function estimateStringTokens(text: string): number {
  if (isDataUrl(text)) return IMAGE_TOKENS
  return Math.ceil(text.length / 3.5)
}

/**
 * Count tokens for a string, preferring the real tokenizer when provided.
 */
async function countStringTokens(text: string, tokenizer?: Tokenizer): Promise<number> {
  // Ahead of the tokenizer: it would happily count 2.5MB of base64 as ~640k real tokens.
  if (isDataUrl(text)) return IMAGE_TOKENS
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
        tokens += IMAGE_TOKENS
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
  // Cutting a data URL produces a corrupt image rather than a shorter one.
  if (isDataUrl(content)) return content
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

  // Same reason as truncateToolResultSync: half a base64 image is not a smaller image.
  if (isDataUrl(message.content)) {
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
// Stale tool-output clearing
// ---------------------------------------------------------------------------

/**
 * Tool outputs in the most recent tail this many tokens deep stay verbatim; older ones are
 * clearable. Recent outputs are what the model is actively working from — older ones have
 * usually already been digested into the assistant's own turns.
 */
const CLEAR_PROTECT_TAIL_TOKENS = 8000

/** Don't bother clearing results at or under this size — the marker costs tokens too. */
const CLEAR_MIN_TOKENS = 200

const CLEARED_MARKER_PREFIX = '[Stale tool result cleared'

/**
 * Cheap context reclamation, tried before the expensive drop-and-summarize compaction: blank
 * the *content* of old tool results in place, keeping the message (and the assistant's call
 * beside it) so the transcript shape stays valid. A long tool-heavy run accumulates huge,
 * mostly-stale payloads — hexdumps, debugger logs, page fetches — whose useful part the model
 * has already restated in its own turns. Clearing them costs nothing the summarizer would have
 * kept anyway, and often makes the conversation fit without dropping a single turn.
 *
 * Only messages outside the protected recent tail are touched, and only when their content is
 * big enough to be worth it. Data-URL images clear too — an old screenshot is IMAGE_TOKENS of
 * pixels the model already looked at. Idempotent: already-cleared markers are skipped.
 */
export function clearStaleToolOutputs(
  messages: ChatMessage[],
  tokenCounts: number[],
  protectTailTokens: number = CLEAR_PROTECT_TAIL_TOKENS,
): { messages: ChatMessage[]; clearedCount: number } {
  // Everything from protectStart onward is the protected recent tail. The message that
  // crosses the threshold is clearable — it is precisely the big stale payload this pass
  // exists to reclaim; protecting it would exempt exactly the wrong messages.
  let acc = 0
  let protectStart = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += tokenCounts[i] ?? 0
    if (acc >= protectTailTokens) break
    protectStart = i
  }

  // The in-flight trailing group — tool results the model has not yet responded to — must
  // survive whole regardless of size: clearing them blanks the very observation the next
  // turn exists to act on. Only applies when the conversation *ends* in tool results.
  let inFlightStart = messages.length
  {
    let i = messages.length - 1
    while (i >= 0 && messages[i]?.role === 'tool') i--
    const anchor = messages[i]
    if (
      i < messages.length - 1 &&
      anchor?.role === 'assistant' &&
      anchor.tool_calls &&
      anchor.tool_calls.length > 0
    ) {
      inFlightStart = i
    }
  }

  let clearedCount = 0
  const out = messages.map((msg, i) => {
    if (i >= protectStart || i >= inFlightStart) return msg
    if (msg.role !== 'tool' || typeof msg.content !== 'string') return msg
    if (msg.content.startsWith(CLEARED_MARKER_PREFIX)) return msg
    if ((tokenCounts[i] ?? 0) <= CLEAR_MIN_TOKENS) return msg
    clearedCount++
    const what = isDataUrl(msg.content) ? 'screenshot' : `~${tokenCounts[i]} tokens`
    return {
      ...msg,
      content: `${CLEARED_MARKER_PREFIX} (${what}) to make room — re-run the tool if you need it again.]`,
    }
  })

  return { messages: out, clearedCount }
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
  let tokenCounts = await Promise.all(processed.map((msg) => countMessageTokens(msg, tokenizer)))
  let totalTokens = tokenCounts.reduce((sum, t) => sum + t, 0)

  // Everything fits — no trimming needed
  if (totalTokens <= budget) {
    return { messages: processed, droppedMessages: [], wasTrimmed: false }
  }

  // Over budget: before dropping anything, try the cheap reclamation — clear stale tool
  // outputs in place. Turns survive verbatim (only old payloads blank), so nothing needs
  // summarizing; if the conversation now fits, the expensive compaction never runs.
  // The protected tail scales down with small contexts — a fixed 8k window inside a 8k
  // budget would protect everything and the pass would never reclaim a byte.
  const protectTail = Math.min(CLEAR_PROTECT_TAIL_TOKENS, Math.floor(budget * 0.25))
  const cleared = clearStaleToolOutputs(processed, tokenCounts, protectTail)
  let fitted = processed
  if (cleared.clearedCount > 0) {
    fitted = cleared.messages
    tokenCounts = await Promise.all(fitted.map((msg) => countMessageTokens(msg, tokenizer)))
    const before = totalTokens
    totalTokens = tokenCounts.reduce((sum, t) => sum + t, 0)
    log.info(
      'context-window',
      `Cleared ${cleared.clearedCount} stale tool outputs: ~${before}t -> ~${totalTokens}t`,
    )
    if (totalTokens <= budget) {
      return { messages: fitted, droppedMessages: [], wasTrimmed: false }
    }
  }

  log.info(
    'context-window',
    `Trimming context: ~${totalTokens + systemTokens + toolDefTokens}t vs ${contextLength}t limit`,
  )

  const truncationNoticeTokens = 30
  const availableTokens = budget - truncationNoticeTokens

  const groups = buildMessageGroups(fitted, tokenCounts)

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
  let forcedGroup: MessageGroup | undefined
  if (tailGroups.length === 0) {
    for (let g = groups.length - 1; g >= headGroupCount; g--) {
      const group = groups[g]
      if (group) {
        forcedGroup = group
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
      const msg = fitted[j]
      if (msg) result.push(msg)
    }
  }

  // Add tail groups
  for (const group of tailGroups) {
    const gIdx = groups.indexOf(group)
    keptGroupIndices.add(gIdx)
    // The forced group was kept despite not fitting, so it has to be trimmed to the budget or
    // the provider rejects the whole request ("Prompt (25751 tokens) exceeds context size").
    // Losing the tail of one oversized tool result is survivable; losing the request is not.
    const perMessage =
      group === forcedGroup
        ? Math.max(64, Math.floor(tailBudget / Math.max(1, group.endIdx - group.startIdx + 1)))
        : 0
    for (let j = group.startIdx; j <= group.endIdx; j++) {
      const msg = fitted[j]
      if (!msg) continue
      if (perMessage > 0 && typeof msg.content === 'string') {
        result.push({ ...msg, content: truncateToolResultSync(msg.content, perMessage) })
      } else {
        result.push(msg)
      }
    }
  }

  // If we somehow fit nothing, include at least the last user message
  if (result.length === 0) {
    const lastUser = [...fitted].reverse().find((m: ChatMessage) => m.role === 'user')
    if (lastUser) {
      result.push(lastUser)
    }
  }

  // Qwen3's chat template raises `No user query found in messages` when handed a conversation
  // containing no user turn, and llama.cpp answers 400 — the entire request fails, not just the
  // trimming. A long unbounded run reaches exactly that shape: one user message (the task
  // prompt) followed by dozens of assistant/tool turns, so once the head group is dropped for
  // exceeding 30% of the budget, every surviving message is an assistant or a tool result.
  //
  // Observed in production: a reverse-engineering task failed three runs in a row on that 400
  // and auto-paused, hours after its conversation grew past the point where the head still fit.
  // The guard above only catches an empty result, which this never is.
  if (!result.some((m) => m.role === 'user')) {
    const anchor = [...fitted].reverse().find((m: ChatMessage) => m.role === 'user')
    if (anchor) result.unshift(anchor)
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
