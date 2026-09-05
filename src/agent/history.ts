import type { ConversationStore } from '../conversation'
import type { ChatMessage } from '../providers/types'
import { hasStrandedToolCall, stripStrandedToolCalls } from '../tools/format'
import { log } from '../util/logger'
import type { AgentContext } from './context'
import { isRolloverRecord } from './handoff'
import { isRecallMessage } from './recall'

/**
 * Strip malformed tool-call markup from assistant content before it is stored.
 *
 * The zero-tool-call recovery path marks its mangled attempts `ephemeral`, so persistNew's
 * filter already keeps those out of the store. But a response that carried a VALID tool call
 * alongside leftover malformed `<tool_call>` markup takes the tool-executing path, which
 * persists the raw content as a normal (non-ephemeral) assistant message — the markup rides
 * along. On the next run that content reloads, and the model imitates its own broken syntax,
 * mangling tool calls immediately (the cross-run poison that stalled Zero). Persistence is the
 * boundary where the poisoning happens, so it is the boundary that cleans it. hasStrandedToolCall
 * only fires on markup that does NOT parse, so valid tool syntax the model should keep learning
 * from is left untouched; the operation is idempotent on already-clean content.
 */
function sanitizeForPersistence(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.role === 'assistant' && typeof m.content === 'string' && hasStrandedToolCall(m.content)
      ? { ...m, content: stripStrandedToolCalls(m.content) }
      : m,
  )
}

/**
 * Bookkeeping for the durable conversation history of one session.
 *
 * Owns the watermarks that track which live messages have already been
 * persisted to the conversation store and which have been seen by the
 * memory extractor, keeping both aligned as messages are appended,
 * spliced (recall replacement), or pruned (compaction).
 */
export class ConversationHistory {
  private store: ConversationStore | null
  private sessionId: string
  private persistedIndex = 0
  /** Index up to which messages have been sent to the extractor */
  private extractionWatermark = 0

  constructor(store: ConversationStore | null, sessionId: string) {
    this.store = store
    this.sessionId = sessionId
  }

  /** Load persisted messages and summary into a fresh context. */
  hydrate(context: AgentContext): void {
    if (!this.store) return

    const stored = this.store.loadMessages(this.sessionId)
    // The transcript is append-only; a rollover record marks where the live window starts.
    // Everything before it stays searchable but is not reloaded into context.
    let windowStart = -1
    for (let i = stored.length - 1; i >= 0; i--) {
      const m = stored[i]
      if (m && isRolloverRecord(m)) {
        windowStart = i
        break
      }
    }
    const history = windowStart > 0 ? stored.slice(windowStart) : stored
    if (history.length > 0) {
      context.messages = history
      this.persistedIndex = history.length
      this.extractionWatermark = history.length
      const retired = windowStart > 0 ? ` (${windowStart} before the last rollover left out)` : ''
      log.info('agent', `Loaded ${history.length} messages for session ${this.sessionId}${retired}`)
    }

    const summary = this.store.loadSummary(this.sessionId)
    if (summary) {
      context.conversationSummary = summary
      log.info('agent', `Loaded conversation summary (${summary.length} chars)`)
    }
  }

  /** Persist messages added since the last call. */
  persistNew(messages: ChatMessage[]): void {
    if (!this.store) return

    try {
      // Recall messages are regenerated per run — persisting them would accumulate stale
      // recalled context in reloaded history. Ephemeral messages are in-run recovery
      // scaffolding (a mangled tool call and its reissue nudge) — persisting those would
      // replay the model's own failure into every future session.
      const newMessages = sanitizeForPersistence(
        messages.slice(this.persistedIndex).filter((m) => !isRecallMessage(m) && !m.ephemeral),
      )
      if (newMessages.length > 0) {
        this.store.appendMessages(this.sessionId, newMessages)
      }
      this.persistedIndex = messages.length
    } catch (error) {
      log.warn('agent', 'Failed to persist conversation:', error)
    }
  }

  /** Adjust watermarks after a message was spliced out at the given index. */
  noteRemovedAt(index: number): void {
    if (index < this.persistedIndex) this.persistedIndex--
    if (index < this.extractionWatermark) this.extractionWatermark--
  }

  /**
   * Remove messages dropped by context fitting from the live message array.
   * Without this, every inference past capacity re-fits and re-summarizes
   * the same middle messages. The conversation store keeps the full history —
   * dropped messages are persisted first, then only the in-memory working
   * set shrinks. Watermarks shift to stay aligned with the new indices.
   */
  prune(messages: ChatMessage[], dropped: ChatMessage[]): ChatMessage[] {
    this.persistNew(messages)

    const droppedSet = new Set(dropped)
    const kept: ChatMessage[] = []
    let removedBeforePersisted = 0
    let removedBeforeExtraction = 0

    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx]
      if (!msg) continue
      if (droppedSet.has(msg)) {
        if (idx < this.persistedIndex) removedBeforePersisted++
        if (idx < this.extractionWatermark) removedBeforeExtraction++
        continue
      }
      kept.push(msg)
    }

    if (kept.length === messages.length) return messages

    log.debug(
      'agent',
      `Pruned ${messages.length - kept.length} compacted messages from live context`,
    )
    this.persistedIndex -= removedBeforePersisted
    this.extractionWatermark -= removedBeforeExtraction
    return kept
  }

  /**
   * Context rollover: persist everything still pending, append the handoff record to the
   * transcript (append-only — nothing is deleted), and align the watermarks with the fresh
   * window, which is exactly `[record]`. The retired messages' extraction is the rollover's
   * memory flush, so the extractor watermark moves past them too.
   */
  rollover(messages: ChatMessage[], record: ChatMessage): void {
    this.persistNew(messages)
    if (this.store) {
      try {
        this.store.appendMessages(this.sessionId, [record])
      } catch (error) {
        log.warn('agent', 'Failed to persist rollover record:', error)
      }
    }
    this.persistedIndex = 1
    this.extractionWatermark = 1
  }

  /** Slice messages not yet seen by the extractor and advance the watermark. */
  takeUnextracted(messages: ChatMessage[]): ChatMessage[] {
    const fresh = messages.slice(this.extractionWatermark)
    if (fresh.length > 0) {
      this.extractionWatermark = messages.length
    }
    return fresh
  }

  /** Replace the stored session with exactly these messages (manual compaction). */
  replaceAll(messages: ChatMessage[]): void {
    this.persistedIndex = 0
    if (!this.store) return

    try {
      this.store.deleteSession(this.sessionId)
      const persistable = sanitizeForPersistence(messages.filter((m) => !isRecallMessage(m)))
      if (persistable.length > 0) {
        this.store.appendMessages(this.sessionId, persistable)
      }
      this.persistedIndex = messages.length
    } catch (error) {
      log.warn('agent', 'Failed to re-persist after compaction:', error)
    }
  }

  /** Delete the stored session entirely. */
  deleteStored(): void {
    this.store?.deleteSession(this.sessionId)
  }

  /** Reset watermarks for a cleared context. */
  reset(): void {
    this.persistedIndex = 0
    this.extractionWatermark = 0
  }
}
