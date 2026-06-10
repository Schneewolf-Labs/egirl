import type { ConversationStore } from '../conversation'
import type { MemoryManager } from '../memory'
import type { ChatMessage, LLMProvider } from '../providers/types'
import { triggerCompaction } from './background'
import type { AgentContext } from './context'
import type { ConversationHistory } from './history'

/**
 * Schedules background context compaction for dropped messages.
 *
 * Keeps a single promise chain so overlapping summarizations never race
 * on the conversation summary — each chained step reads the summary
 * produced by the previous one.
 */
export class CompactionScheduler {
  /** Tracks in-flight compaction so the next turn can await it before reading summary */
  private pending: Promise<void> | null = null

  /**
   * Prune the dropped messages from the live context and chain a
   * background summarization of them onto any in-flight compaction.
   */
  schedule(args: {
    droppedMessages: ChatMessage[]
    context: AgentContext
    history: ConversationHistory
    provider: LLMProvider
    memory: MemoryManager | null
    conversationStore: ConversationStore | null
  }): void {
    const { droppedMessages, context, history, provider, memory, conversationStore } = args

    // Filter out the summary message itself — only summarize real conversation
    const droppedConversation = droppedMessages.filter(
      (m) =>
        !(
          m.role === 'system' &&
          typeof m.content === 'string' &&
          m.content.startsWith('[Conversation summary')
        ),
    )
    if (droppedConversation.length === 0) return

    context.messages = history.prune(context.messages, droppedConversation)

    // Chain onto any in-flight compaction instead of overwriting it —
    // overlapping summarizations raced on conversationSummary and lost
    // updates. existingSummary is read when the chained step runs.
    const previous = this.pending ?? Promise.resolve()
    this.pending = previous.then(() =>
      triggerCompaction({
        droppedMessages: droppedConversation,
        provider,
        existingSummary: context.conversationSummary,
        memory,
        conversationStore,
        sessionId: context.sessionId,
        onSummary: (summary) => {
          context.conversationSummary = summary
        },
      }),
    )
  }

  /** Await any in-flight compaction so the next turn reads a settled summary. */
  async drain(): Promise<void> {
    if (!this.pending) return
    await this.pending
    this.pending = null
  }

  /** Drop the chain without awaiting it (context was cleared). */
  reset(): void {
    this.pending = null
  }
}
