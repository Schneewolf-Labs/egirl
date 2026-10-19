import type {
  Options as ClaudeAgentOptions,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentEventHandler } from '../agent/events'
import type { ThinkingConfig, ToolCall } from '../providers/types'
import { errorMessage } from '../util/errors'
import { parseDataUrl, stripToolPrefix } from './claude-tools'
import { emptyOutcome, type HarnessOutcome } from './hosted-types'

/** What goes over the wire to the Claude Agent SDK and what comes back, in egirl's terms. */

/** egirl's thinking level in the SDK's terms: off is off; anything else is an effort hint. */
export function thinkingOptions(
  level: ThinkingConfig['level'],
): Pick<ClaudeAgentOptions, 'thinking' | 'effort'> {
  if (level === 'off') return { thinking: { type: 'disabled' } }
  return { effort: level }
}

/** A streamed content delta, forwarded as the token events the surfaces already render. */
export function streamDelta(event: unknown, events: AgentEventHandler): void {
  const e = event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } }
  if (e.type !== 'content_block_delta' || !e.delta) return
  if (e.delta.type === 'text_delta' && e.delta.text) events.onToken?.(e.delta.text)
  if (e.delta.type === 'thinking_delta' && e.delta.thinking) {
    events.onThinkingToken?.(e.delta.thinking)
  }
}

export interface AssistantContent {
  text: string
  thinking: string
  calls: ToolCall[]
}

/** Text, thinking and tool calls out of one assistant message, tool names as egirl knows them. */
export function readAssistant(message: unknown): AssistantContent {
  const content = (message as { content?: unknown }).content
  const texts: string[] = []
  const thoughts: string[] = []
  const calls: ToolCall[] = []
  if (Array.isArray(content)) {
    for (const block of content as Array<{
      type?: string
      text?: string
      thinking?: string
      id?: string
      name?: string
      input?: unknown
    }>) {
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        thoughts.push(block.thinking)
      }
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const args =
          block.input && typeof block.input === 'object'
            ? (block.input as Record<string, unknown>)
            : {}
        calls.push({
          id: block.id ?? block.name,
          name: stripToolPrefix(block.name),
          arguments: args,
        })
      }
    }
  }
  return { text: texts.join('\n').trim(), thinking: thoughts.join('\n\n').trim(), calls }
}

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

/**
 * A single user turn carrying image blocks, so Claude sees the attachment rather than a path
 * to a file it has no tool to read. The SDK takes it as a one-message input stream.
 */
export async function* userTurnWithImages(
  text: string,
  dataUrls: string[],
): AsyncIterable<SDKUserMessage> {
  const images = dataUrls
    .map(parseDataUrl)
    .filter(
      (i): i is { mimeType: ImageMediaType; data: string } => !!i && IMAGE_TYPES.has(i.mimeType),
    )
  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        { type: 'text', text },
        ...images.map((i) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: i.mimeType, data: i.data },
        })),
      ],
    },
  }
}

/**
 * Drain one SDK query into an outcome, narrating as it goes: streamed text and thinking as
 * token events, each batch of tool calls as the surfaces expect them, the session id the SDK
 * assigned so the next turn can resume it. Subagent frames are ignored; there are none here.
 */
export async function consumeQuery(
  stream: AsyncIterable<SDKMessage>,
  controller: AbortController,
  events: AgentEventHandler,
  onSession: (claudeSessionId: string) => void,
): Promise<HarnessOutcome> {
  const outcome = emptyOutcome()
  const thinkingParts: string[] = []
  let lastText = ''

  try {
    for await (const message of stream) {
      if (controller.signal.aborted) break
      if (message.type === 'system' && message.subtype === 'init') {
        onSession(message.session_id)
        continue
      }
      if (message.type === 'stream_event') {
        if (message.parent_tool_use_id === null) streamDelta(message.event, events)
        continue
      }
      if (message.type === 'assistant') {
        if (message.parent_tool_use_id !== null) continue
        outcome.sawAssistant = true
        // Each model call's prompt size; the result's usage is summed over every call in the run.
        const u = (message.message as { usage?: Partial<Record<string, number>> }).usage
        if (u?.input_tokens) {
          outcome.contextTokens =
            u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        }
        const read = readAssistant(message.message)
        if (read.text) lastText = read.text
        if (read.thinking) thinkingParts.push(read.thinking)
        if (read.calls.length > 0) events.onToolCallStart?.(read.calls)
        continue
      }
      if (message.type === 'result') {
        outcome.turns = message.num_turns
        const usage = message.usage
        const cached =
          (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        outcome.usage = {
          input_tokens: usage.input_tokens + cached,
          output_tokens: usage.output_tokens,
        }
        if (message.subtype === 'success') {
          outcome.content = message.result || lastText
        } else if (message.subtype === 'error_max_turns') {
          outcome.turnLimitReached = true
          outcome.error = message.subtype
        } else {
          outcome.error = message.errors.join('; ') || message.subtype
        }
      }
    }
  } catch (error) {
    // Our own abort surfaces as the SDK's "process aborted by user" error.
    // The SDK also throws after an error result; the result already said what went wrong.
    if (!controller.signal.aborted && !outcome.error) outcome.error = errorMessage(error)
  }
  if (!outcome.content) outcome.content = lastText
  outcome.thinking = thinkingParts.join('\n\n')
  return outcome
}
