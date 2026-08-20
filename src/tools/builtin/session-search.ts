/**
 * session_search -- let the agent search its own past conversations.
 *
 * Memory extraction keeps distilled facts; this keeps access to everything else. "What did we
 * conclude about the RFH header?" has an exact answer sitting in a transcript from last week,
 * and without this tool the agent's only options were to rediscover it or to have happened to
 * extract it as a memory at the time. FTS5 keyword search, no embeddings -- which is the
 * point: it works on instances with no embeddings server at all.
 *
 * The idea is hermes-agent's session_search; the index lives in ConversationStore.
 */

import type { ConversationStore } from '../../conversation'
import type { Tool } from '../types'

function ago(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export function createSessionSearchTool(store: ConversationStore): Tool {
  return {
    definition: {
      name: 'session_search',
      description:
        'Search your own past conversations (all sessions, keyword match). Use when the user ' +
        'refers to something discussed before, or when past work likely answers a current ' +
        'question. Returns matching excerpts with their session and age.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords to search for (plain words; all must match)',
          },
          limit: {
            type: 'number',
            description: 'Maximum results (default 12)',
          },
        },
        required: ['query'],
      },
    },
    async execute(params: Record<string, unknown>) {
      const query = String(params.query ?? '')
      const limit = Number(params.limit) || 12
      // The executor is shared across sessions, so the caller's own session cannot be
      // excluded here; the [session · age] prefix keeps provenance visible instead.
      const hits = store.searchMessages(query, { limit })
      if (hits.length === 0) {
        return { success: true, output: `No past-conversation matches for "${query}".` }
      }
      const lines = hits.map(
        (h) => `[${h.sessionId} · ${ago(h.createdAt)} · ${h.role}] ${h.snippet}`,
      )
      return { success: true, output: lines.join('\n') }
    },
  }
}
