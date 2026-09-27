import type { ModelTurn } from '../agent/events'
import type { RuntimeConfig } from '../config'
import { createLlamaCppProvider } from '../providers/llamacpp'
import type { ChatMessage, LLMProvider, ToolCall } from '../providers/types'
import { errorMessage } from '../util/errors'
import { log } from '../util/logger'

/**
 * The shadow tutor: a stronger model shown exactly what the operator was shown, every turn,
 * whose answer is recorded beside the operator's and never acted on.
 *
 * Distilling from trajectories the frontier model drives itself is off-policy: it never makes a
 * small operator's mistakes, so the student learns moves it cannot follow up and never sees a
 * recovery. Labelling the states the operator actually reaches is the DAgger fix — the operator
 * keeps driving, the tutor says what it would have done from there. Where the two differ, the
 * transcript holds a preference pair; where the run went sideways, it holds the expert's way out.
 *
 * The operator stays the only thing that decides. This is data capture, not routing.
 */

export interface TutorLabel {
  model: string
  content: string
  thinking?: string
  tool_calls?: ToolCall[]
  finish_reason?: string
  usage?: { input_tokens: number; output_tokens: number }
  ms: number
  error?: string
}

export interface ShadowTutor {
  label(turn: ModelTurn): Promise<TutorLabel>
}

export function createShadowTutor(tutor: NonNullable<RuntimeConfig['tutor']>): ShadowTutor {
  const provider = createLlamaCppProvider(
    tutor.endpoint,
    tutor.model,
    undefined,
    tutor.maxConcurrent,
    tutor.temperature,
    tutor.apiKey,
    undefined,
    undefined,
    true,
  )
  return shadowTutorFor(provider, tutor.model, tutor.timeoutMs)
}

/** The tutor over any provider; split out so tests can hand it a stub. */
export function shadowTutorFor(
  provider: LLMProvider,
  model: string,
  timeoutMs: number,
): ShadowTutor {
  return {
    async label(turn: ModelTurn): Promise<TutorLabel> {
      const started = Date.now()
      try {
        // No thinking config and no cache slot: both ride on llama.cpp-only request fields
        // that a hosted API rejects, and neither changes what the tutor is being asked.
        const response = await provider.chat({
          messages: uniqueToolCallIds(turn.messages),
          tools: turn.tools,
          signal: AbortSignal.timeout(timeoutMs),
        })
        return {
          model: response.model || model,
          content: response.content,
          ...(response.thinking && { thinking: response.thinking }),
          ...(response.tool_calls && { tool_calls: response.tool_calls }),
          finish_reason: response.finish_reason,
          usage: response.usage,
          ms: Date.now() - started,
        }
      } catch (error) {
        const message = errorMessage(error)
        log.warn('tutor', `Shadow tutor failed on a turn: ${message}`)
        return { model, content: '', ms: Date.now() - started, error: message }
      }
    },
  }
}

/**
 * Renumber tool-call ids so each is unique across the whole conversation. Local parsing falls
 * back to `call_0`, `call_1`, ... per turn, which llama.cpp accepts and hosted APIs that pair
 * results to calls by id (Anthropic's among them) reject as duplicates.
 */
export function uniqueToolCallIds(messages: ChatMessage[]): ChatMessage[] {
  let next = 0
  let current = new Map<string, string>()
  return messages.map((msg) => {
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      current = new Map()
      const calls = msg.tool_calls.map((tc) => {
        const id = `call_${next++}`
        current.set(tc.id, id)
        return { ...tc, id }
      })
      return { ...msg, tool_calls: calls }
    }
    if (msg.role === 'tool' && msg.tool_call_id !== undefined) {
      const id = current.get(msg.tool_call_id)
      return id ? { ...msg, tool_call_id: id } : msg
    }
    return msg
  })
}
