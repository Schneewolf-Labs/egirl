import type { ConversationStore } from '../conversation'
import type { MemoryManager } from '../memory'
import { flushBeforeCompaction } from '../memory/compaction-flush'
import { extractMemories } from '../memory/extractor'
import type { ChatMessage, LLMProvider } from '../providers/types'
import { log } from '../util/logger'
import { summarizeMessages } from './context-summarizer'

/**
 * Summarize dropped messages and update the conversation summary.
 * Before summarizing, flushes durable facts to memory so they survive
 * even if the summary is lossy or fails.
 *
 * Runs asynchronously — returns a promise the caller can await if needed,
 * but in practice it's fire-and-forget.
 */
export function triggerCompaction(args: {
  droppedMessages: ChatMessage[]
  provider: LLMProvider
  existingSummary: string | undefined
  memory: MemoryManager | null
  conversationStore: ConversationStore | null
  sessionId: string
  onSummary: (summary: string) => void
}): Promise<void> {
  const {
    droppedMessages,
    provider,
    existingSummary,
    memory,
    conversationStore,
    sessionId,
    onSummary,
  } = args

  const flushPromise = memory
    ? flushDroppedToMemory({ droppedMessages, provider, memory, sessionId })
    : Promise.resolve()

  const summaryPromise = summarizeMessages(droppedMessages, provider, existingSummary)
    .then((summary) => {
      onSummary(summary)
      log.info('agent', `Context compacted: summary updated (${summary.length} chars)`)

      if (conversationStore) {
        try {
          conversationStore.updateSummary(sessionId, summary)
        } catch (error) {
          log.warn('agent', 'Failed to persist compacted summary:', error)
        }
      }
    })
    .catch((error) => {
      log.warn('agent', 'Context compaction failed:', error)
    })

  return Promise.all([flushPromise, summaryPromise]).then(() => {})
}

/**
 * Extract and persist key facts from messages being dropped during compaction.
 * Prevents silent context loss — facts survive in durable memory even if
 * the LLM summary is lossy or compaction fails entirely.
 */
export function flushDroppedToMemory(args: {
  droppedMessages: ChatMessage[]
  provider: LLMProvider
  memory: MemoryManager
  sessionId: string
}): Promise<void> {
  const { droppedMessages, provider, memory, sessionId } = args

  return flushBeforeCompaction(droppedMessages, provider)
    .then(async (extractions) => {
      if (extractions.length === 0) return

      log.info(
        'agent',
        `Pre-compaction flush: persisting ${extractions.length} memories from dropped context`,
      )

      for (const extraction of extractions) {
        try {
          const key = `compaction/${extraction.key}`
          await memory.set(key, extraction.value, {
            category: extraction.category,
            source: 'compaction',
            sessionId,
          })
          log.debug('agent', `Flushed compaction memory: ${key} [${extraction.category}]`)
        } catch (error) {
          log.warn('agent', `Failed to flush compaction memory ${extraction.key}:`, error)
        }
      }
    })
    .catch((error) => {
      log.warn('agent', 'Pre-compaction memory flush failed:', error)
    })
}

/**
 * Run automatic memory extraction in the background.
 * Does not block the response — failures are logged and swallowed.
 */
export function runAutoExtraction(args: {
  messages: ChatMessage[]
  provider: LLMProvider
  memory: MemoryManager
  sessionId: string
  minMessages: number
  maxExtractions: number
}): void {
  const { messages, provider, memory, sessionId, minMessages, maxExtractions } = args

  extractMemories(messages, provider, { minMessages, maxExtractions })
    .then(async (extractions) => {
      if (extractions.length === 0) return

      log.info('agent', `Auto-extracted ${extractions.length} memories from conversation`)

      for (const extraction of extractions) {
        try {
          const duplicate = await memory.checkDuplicate(extraction.value)
          if (duplicate) {
            log.debug(
              'agent',
              `Skipping duplicate extraction "${extraction.key}" (similar to ${duplicate})`,
            )
            continue
          }

          const key = `auto/${extraction.key}`
          await memory.set(key, extraction.value, {
            category: extraction.category,
            source: 'auto',
            sessionId,
          })
          log.debug('agent', `Stored auto-extracted memory: ${key} [${extraction.category}]`)
        } catch (error) {
          log.warn('agent', `Failed to store extracted memory ${extraction.key}:`, error)
        }
      }
    })
    .catch((error) => {
      log.warn('agent', 'Auto-extraction failed:', error)
    })
}
