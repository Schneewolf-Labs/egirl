import type { ChatResponse, ToolCall } from '../providers/types'
import type { ToolExecutor, ToolResult } from '../tools'
import { trace } from '../tracking/traces'
import type { TranscriptLogger } from '../tracking/transcript'
import { log } from '../util/logger'
import { type AgentContext, addMessage } from './context'
import { truncateToolResultSync } from './context-window'
import type { AgentEventHandler } from './events'
import { duplicateToolWarning } from './nudges'

/** Default max tokens per tool result — matches context-window.ts default */
const MAX_TOOL_RESULT_TOKENS = 8000

/**
 * Execute the tool calls from a model response and append the paired
 * assistant/tool messages to the context. Detects repeated identical
 * calls and injects a loop warning so the model changes course.
 */
export async function runToolCalls(args: {
  response: ChatResponse
  context: AgentContext
  executor: ToolExecutor
  seenToolCalls: Set<string>
  transcript: TranscriptLogger | null
  events?: AgentEventHandler
  signal?: AbortSignal
}): Promise<{ awaitingInput: boolean }> {
  const { response, context, executor, seenToolCalls, transcript, events, signal } = args
  const calls = response.tool_calls ?? []

  const duplicateNames: string[] = []
  for (const call of calls) {
    const key = `${call.name}:${JSON.stringify(call.arguments)}`
    if (seenToolCalls.has(key)) duplicateNames.push(call.name)
    seenToolCalls.add(key)
  }

  addMessage(context, {
    role: 'assistant',
    content: response.content,
    tool_calls: calls,
  })

  if (response.content && events?.onThinking) events.onThinking(response.content)
  events?.onToolCallStart?.(calls)

  let awaitingInput = false
  const toolResults = await executeToolsWithHooks({
    toolCalls: calls,
    context,
    executor,
    transcript,
    events,
    signal,
  })

  for (const [callId, result] of toolResults) {
    if (result.awaitingInput) awaitingInput = true
    log.debug(
      'agent',
      `Tool ${callId}: ${result.output.substring(0, 100)}${result.output.length > 100 ? '...' : ''}`,
    )

    const call = calls.find((c) => c.id === callId)
    events?.onToolCallComplete?.(callId, call?.name ?? 'unknown', result)

    // Full-payload tool trace: the transcript logger keeps arg KEYS only; post-mortems need
    // the actual command and the actual output.
    trace({
      session: context.sessionId,
      kind: 'tool',
      name: call?.name ?? 'unknown',
      success: result.success,
      payload: {
        args: JSON.stringify(call?.arguments ?? {}),
        output: result.output,
      },
    })

    // Truncate oversized tool results at ingestion to prevent context bloat.
    const truncatedOutput = truncateToolResultSync(result.output, MAX_TOOL_RESULT_TOKENS)

    addMessage(context, {
      role: 'tool',
      content: truncatedOutput,
      tool_call_id: callId,
    })
  }

  if (duplicateNames.length > 0) {
    const names = [...new Set(duplicateNames)].join(', ')
    log.warn('agent', `Tool loop detected: repeated call(s) to ${names}`)
    addMessage(context, { role: 'user', content: duplicateToolWarning(names) })
  }

  return { awaitingInput }
}

async function executeToolsWithHooks(args: {
  toolCalls: ToolCall[]
  context: AgentContext
  executor: ToolExecutor
  transcript: TranscriptLogger | null
  events?: AgentEventHandler
  signal?: AbortSignal
}): Promise<Map<string, ToolResult>> {
  const { toolCalls, context, executor, transcript, events, signal } = args

  // Don't start new tools after the run is aborted — emit skip results so
  // tool messages stay paired with their tool_calls in history.
  const skippedResult = (): ToolResult => ({
    success: false,
    output: 'Skipped: agent run was cancelled',
  })

  if (!events?.onBeforeToolExec && !events?.onAfterToolExec && !transcript) {
    if (signal?.aborted) {
      return new Map(toolCalls.map((call) => [call.id, skippedResult()]))
    }
    return executor.executeAll(toolCalls, context.workspaceDir)
  }

  const results = new Map<string, ToolResult>()

  for (const call of toolCalls) {
    if (signal?.aborted) {
      results.set(call.id, skippedResult())
      continue
    }

    if (events?.onBeforeToolExec) {
      const shouldRun = await events.onBeforeToolExec(call)
      if (shouldRun === false) {
        const skipped: ToolResult = {
          success: false,
          output: `Tool ${call.name} skipped by hook`,
        }
        events?.onAfterToolExec?.(call, skipped)
        results.set(call.id, skipped)
        continue
      }
    }

    const toolStart = Date.now()
    const result = await executor.execute(call, context.workspaceDir)
    const toolDuration = Date.now() - toolStart

    events?.onAfterToolExec?.(call, result)
    transcript?.toolCall(context.sessionId, {
      tool: call.name,
      args_keys: Object.keys(call.arguments),
      success: result.success,
      duration_ms: toolDuration,
    })

    results.set(call.id, result)
  }

  return results
}
