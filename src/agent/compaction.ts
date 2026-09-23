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
  /** Bumped by reset(): a job scheduled before it belongs to a context that no longer exists. */
  private generation = 0

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

    const generation = this.generation

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
        // A job that outlives reset() must not write its summary back: the sessions row it
        // would update is the fresh conversation's. Model: formal/Compaction.tla.
        isCurrent: () => this.generation === generation,
        onSummary: (summary) => {
          context.conversationSummary = summary
        },
      }),
    )
  }

  /** Await any in-flight compaction so the next turn reads a settled summary. */
  async drain(): Promise<void> {
    const awaited = this.pending
    if (!awaited) return
    await awaited
    // Only clear what was awaited: a job chained on meanwhile is still in flight, and dropping
    // it would let the next schedule() start a second chain beside it, both summarizing from
    // the same base. Model: formal/Compaction.tla (NoLostSummary).
    if (this.pending === awaited) this.pending = null
  }

  /** Drop the chain without awaiting it (context was cleared). */
  reset(): void {
    this.pending = null
    this.generation++
  }
}
