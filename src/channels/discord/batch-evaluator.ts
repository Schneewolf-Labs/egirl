import type { Message } from 'discord.js'
import type { LLMProvider } from '../../providers/types'
import { log } from '../../util/logger'

export interface BufferedMessage {
  author: string
  authorId: string
  content: string
  timestamp: Date
  message: Message
}

interface BatchConfig {
  windowMs: number
}

type BatchReadyCallback = (channelId: string, messages: BufferedMessage[]) => void | Promise<void>

/**
 * Buffers messages per channel with a debounce timer.
 * When no new messages arrive within the window, fires onReady with the batch.
 */
export class MessageBatcher {
  private buffers = new Map<string, BufferedMessage[]>()
  private timers = new Map<string, Timer>()
  private windowMs: number
  private onReady: BatchReadyCallback

  constructor(config: BatchConfig, onReady: BatchReadyCallback) {
    this.windowMs = config.windowMs
    this.onReady = onReady
  }

  add(channelId: string, msg: BufferedMessage): void {
    const buffer = this.buffers.get(channelId) ?? []
    buffer.push(msg)
    this.buffers.set(channelId, buffer)

    // Reset debounce timer
    const existing = this.timers.get(channelId)
    if (existing) clearTimeout(existing)

    this.timers.set(channelId, setTimeout(() => {
      this.flush(channelId)
    }, this.windowMs))
  }

  /** Flush a channel's buffer immediately and cancel its timer */
  flushNow(channelId: string): BufferedMessage[] {
    const existing = this.timers.get(channelId)
    if (existing) clearTimeout(existing)
    this.timers.delete(channelId)

    const messages = this.buffers.get(channelId) ?? []
    this.buffers.delete(channelId)
    return messages
  }

  private async flush(channelId: string): Promise<void> {
    const messages = this.buffers.get(channelId)
    if (!messages || messages.length === 0) return

    this.buffers.delete(channelId)
    this.timers.delete(channelId)

    try {
      await this.onReady(channelId, messages)
    } catch (error) {
      log.error('batch', 'Batch ready callback failed:', error)
    }
  }

  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.buffers.clear()
    this.timers.clear()
  }
}

export interface RelevanceDecision {
  shouldRespond: boolean
  reason: string
}

/**
 * Ask the local model whether the bot should respond to a batch of
 * observed channel messages. Uses a lightweight prompt with no tools.
 */
export async function evaluateRelevance(
  provider: LLMProvider,
  messages: BufferedMessage[],
  botName: string,
): Promise<RelevanceDecision> {
  const formatted = messages
    .map(m => `[${m.author}]: ${m.content}`)
    .join('\n')

  const prompt = `You are ${botName}, an AI assistant passively monitoring a Discord channel. Review these recent messages and decide if you should jump in.

Respond if:
- Someone asks a question you can help with
- The conversation involves a topic where you have relevant expertise (programming, technical topics, research)
- Someone is confused or stuck on something you can assist with
- You are mentioned by name (not an @mention, but by name in the text)

Do NOT respond if:
- It's casual social conversation or banter
- The topic is outside your areas of knowledge
- Others have already adequately answered
- It would be intrusive or annoying to interject
- The messages are simple acknowledgments, greetings, or reactions

Recent messages:
${formatted}

Should you respond? Reply with exactly "RESPOND: yes" or "RESPOND: no" followed by a one-line reason.`

  try {
    const response = await provider.chat({
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      temperature: 0.1,
      max_tokens: 100,
    })

    const text = response.content.toLowerCase()
    const shouldRespond = text.includes('respond: yes')
    // Extract reason from the line after the RESPOND verdict
    const lines = response.content.trim().split('\n')
    const reason = lines.length > 1 ? lines.slice(1).join(' ').trim() : ''

    log.debug('batch', `Relevance check: ${shouldRespond ? 'yes' : 'no'} — ${reason}`)
    return { shouldRespond, reason }
  } catch (error) {
    log.error('batch', 'Relevance evaluation failed:', error)
    return { shouldRespond: false, reason: 'evaluation error' }
  }
}

/**
 * Format a batch of buffered messages into a single user message
 * for the agent loop to respond to.
 */
export function formatBatchForAgent(messages: BufferedMessage[]): string {
  const lines = messages
    .map(m => `${m.author}: ${m.content}`)
    .join('\n')

  return `[The following conversation happened in a channel you're monitoring. You weren't directly addressed, but based on context you may have something useful to contribute. Respond naturally as if joining the conversation — be concise and add value, don't repeat what's been said.]\n\n${lines}`
}
