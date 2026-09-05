import type { ConversationStore } from '../conversation'
import type { MemoryManager } from '../memory'
import type { ChatMessage, LLMProvider } from '../providers/types'
import type { Tool } from '../tools/types'
import { log } from '../util/logger'
import { flushDroppedToMemory } from './background'
import type { AgentContext } from './context'
import type { ConversationHistory } from './history'

/**
 * Context rollover plumbing: the two loop-intrinsic tools the model steers its own window
 * with, and the state transition that installs a fresh window. The record itself is built in
 * ./handoff.ts. Rollover replaces drop-and-summarize compaction when
 * `conversation.context_rollover` is on (or per run, for unbounded tasks).
 */

/**
 * Context utilization (last prompt tokens / window) at which the loop injects the checkpoint
 * nudge: the window is filling and compaction or rollover is imminent, so durable capture must
 * happen now. Shared with the loop so the nudge and `context_remaining` agree.
 */
export const CONTEXT_BREAK_THRESHOLD = 0.8

export interface RolloverRequest {
  handoff?: string
}

export interface RolloverToolDeps {
  contextLength: number
  /** Prompt size of the last inference — the live measure of how full the window is. */
  lastInputTokens: () => number
  /** Called by new_context; the loop performs the rollover once the tool batch completes. */
  requestRollover: (request: RolloverRequest) => void
}

/**
 * Tools that only make sense inside the loop: they read and mutate the run's own window, so
 * they are executed by the loop rather than registered on the shared ToolExecutor.
 */
export function createRolloverTools(deps: RolloverToolDeps): Map<string, Tool> {
  const contextRemaining: Tool = {
    definition: {
      name: 'context_remaining',
      description:
        'How full your context window is. Use it to decide whether to checkpoint your notes and ' +
        'call new_context before the window rolls over on its own.',
      parameters: { type: 'object', properties: {} },
    },
    async execute() {
      const used = deps.lastInputTokens()
      const pct = Math.round((used / Math.max(1, deps.contextLength)) * 100)
      const untilCheckpoint = Math.max(
        0,
        Math.floor(deps.contextLength * CONTEXT_BREAK_THRESHOLD) - used,
      )
      return {
        success: true,
        output:
          `Context window: ${used} of ${deps.contextLength} tokens used (${pct}%). ` +
          `About ${untilCheckpoint} tokens until the checkpoint nudge; automatic rollover ` +
          'follows when the conversation no longer fits. Once your notes are current, ' +
          'new_context rolls over on your own terms.',
      }
    },
  }

  const newContext: Tool = {
    definition: {
      name: 'new_context',
      description:
        'Roll over to a fresh context window as soon as this tool batch completes. Older ' +
        'assistant prose and consumed tool results are retired; your direct inputs, pending ' +
        'tool results and the handoff text below carry over, and the full transcript stays ' +
        'searchable with session_search. Use it right after a checkpoint (notes written, ' +
        'artifacts saved) when the window is cluttered with results you no longer need.',
      parameters: {
        type: 'object',
        properties: {
          handoff: {
            type: 'string',
            description:
              'What you are doing right now and the very next step, 1-5 lines. Do not ' +
              'restate what is already in your notes.',
          },
        },
      },
    },
    async execute(params) {
      const handoff = typeof params.handoff === 'string' ? params.handoff : undefined
      deps.requestRollover({ handoff })
      return {
        success: true,
        output:
          'Context rollover scheduled: it happens as soon as this tool batch completes. ' +
          `${handoff ? 'Your handoff text will head the fresh window.' : 'No handoff text given — the fresh window starts from your notes and the mechanical record.'}`,
      }
    },
  }

  return new Map([
    [contextRemaining.definition.name, contextRemaining],
    [newContext.definition.name, newContext],
  ])
}

/**
 * Install a fresh window: persist what is being retired, append the record to the transcript
 * (so a restart resumes from it), replace the live messages, drop the lossy summary, and flush
 * durable facts from the retired messages to memory in the background.
 */
export function performRollover(args: {
  context: AgentContext
  history: ConversationHistory
  record: ChatMessage
  dropped: ChatMessage[]
  provider: LLMProvider
  memory: MemoryManager | null
  conversationStore: ConversationStore | null
}): void {
  const { context, history, record, dropped, provider, memory, conversationStore } = args

  history.rollover(context.messages, record)
  context.messages = [record]

  if (context.conversationSummary) {
    context.conversationSummary = undefined
    try {
      conversationStore?.updateSummary(context.sessionId, '')
    } catch (error) {
      log.warn('agent', 'Failed to clear conversation summary on rollover:', error)
    }
  }

  log.info(
    'agent',
    `Context rollover: retired ${dropped.length} messages for a ${String(record.content).length}-char handoff record`,
  )

  if (memory && dropped.length > 0) {
    void flushDroppedToMemory({
      droppedMessages: dropped,
      provider,
      memory,
      sessionId: context.sessionId,
    })
  }
}
