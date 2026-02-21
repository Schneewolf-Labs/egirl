import { appendFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { log } from '../util/logger'

/**
 * Discriminated union of transcript entry types.
 * Each turn appends multiple entries to a session-scoped JSONL file,
 * enabling replay, cost analysis, and post-mortem debugging.
 */

interface BaseEntry {
  ts: string
  session: string
}

export interface TurnStartEntry extends BaseEntry {
  type: 'turn_start'
  message: string
}

export interface MemoryRecallEntry extends BaseEntry {
  type: 'memory_recall'
  query: string
  recalled_chars: number
}

export interface RoutingEntry extends BaseEntry {
  type: 'routing'
  target: 'local' | 'remote'
  reason: string
  confidence: number
  provider?: string
}

export interface InferenceEntry extends BaseEntry {
  type: 'inference'
  provider: string
  target: 'local' | 'remote'
  input_tokens: number
  output_tokens: number
  duration_ms: number
  has_tool_calls: boolean
}

export interface EscalationEntry extends BaseEntry {
  type: 'escalation'
  from: string
  to: string
  reason: string
  confidence: number
}

export interface ToolCallEntry extends BaseEntry {
  type: 'tool_call'
  tool: string
  args_keys: string[]
  success: boolean
  duration_ms: number
}

export interface TokenBudgetEntry extends BaseEntry {
  type: 'token_budget'
  level: 'high' | 'critical'
  utilization: number
  input_tokens: number
  context_length: number
}

export interface TurnEndEntry extends BaseEntry {
  type: 'turn_end'
  content_length: number
  target: 'local' | 'remote'
  provider: string
  input_tokens: number
  output_tokens: number
  escalated: boolean
  turns: number
  duration_ms: number
}

export type TranscriptEntry =
  | TurnStartEntry
  | MemoryRecallEntry
  | RoutingEntry
  | InferenceEntry
  | EscalationEntry
  | ToolCallEntry
  | TokenBudgetEntry
  | TurnEndEntry

export interface TranscriptConfig {
  enabled: boolean
  path: string
}

/**
 * Append-only JSONL transcript logger.
 * One file per session: {transcriptDir}/{sessionId}.jsonl
 */
export class TranscriptLogger {
  private dir: string
  private dirCreated = false

  constructor(transcriptDir: string) {
    this.dir = transcriptDir
  }

  async append(entry: TranscriptEntry): Promise<void> {
    try {
      if (!this.dirCreated) {
        await mkdir(this.dir, { recursive: true })
        this.dirCreated = true
      }

      // Sanitize session ID for filesystem safety
      const safeSession = entry.session.replace(/[^a-zA-Z0-9_:-]/g, '_')
      const filePath = join(this.dir, `${safeSession}.jsonl`)
      const line = `${JSON.stringify(entry)}\n`
      await appendFile(filePath, line, 'utf-8')
    } catch (error) {
      log.warn('transcript', `Failed to write transcript entry: ${error}`)
    }
  }

  turnStart(session: string, message: string): Promise<void> {
    return this.append({
      ts: new Date().toISOString(),
      session,
      type: 'turn_start',
      message: message.slice(0, 500),
    })
  }

  memoryRecall(session: string, query: string, recalledChars: number): Promise<void> {
    return this.append({
      ts: new Date().toISOString(),
      session,
      type: 'memory_recall',
      query: query.slice(0, 200),
      recalled_chars: recalledChars,
    })
  }

  routing(
    session: string,
    decision: { target: 'local' | 'remote'; reason: string; confidence: number; provider?: string },
  ): Promise<void> {
    return this.append({
      ts: new Date().toISOString(),
      session,
      type: 'routing',
      target: decision.target,
      reason: decision.reason,
      confidence: decision.confidence,
      provider: decision.provider,
    })
  }

  inference(
    session: string,
    data: {
      provider: string
      target: 'local' | 'remote'
      input_tokens: number
      output_tokens: number
      duration_ms: number
      has_tool_calls: boolean
    },
  ): Promise<void> {
    return this.append({
      ts: new Date().toISOString(),
      session,
      type: 'inference',
      ...data,
    })
  }

  escalation(
    session: string,
    data: { from: string; to: string; reason: string; confidence: number },
  ): Promise<void> {
    return this.append({
      ts: new Date().toISOString(),
      session,
      type: 'escalation',
      ...data,
    })
  }

  toolCall(
    session: string,
    data: { tool: string; args_keys: string[]; success: boolean; duration_ms: number },
  ): Promise<void> {
    return this.append({
      ts: new Date().toISOString(),
      session,
      type: 'tool_call',
      ...data,
    })
  }

  tokenBudget(
    session: string,
    data: {
      level: 'high' | 'critical'
      utilization: number
      input_tokens: number
      context_length: number
    },
  ): Promise<void> {
    return this.append({
      ts: new Date().toISOString(),
      session,
      type: 'token_budget',
      ...data,
    })
  }

  turnEnd(
    session: string,
    data: {
      content_length: number
      target: 'local' | 'remote'
      provider: string
      input_tokens: number
      output_tokens: number
      escalated: boolean
      turns: number
      duration_ms: number
    },
  ): Promise<void> {
    return this.append({
      ts: new Date().toISOString(),
      session,
      type: 'turn_end',
      ...data,
    })
  }
}

export function createTranscriptLogger(config: TranscriptConfig): TranscriptLogger | undefined {
  if (!config.enabled) return undefined
  return new TranscriptLogger(config.path)
}
