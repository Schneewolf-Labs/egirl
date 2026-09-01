import {
  type CanUseTool,
  type Options as ClaudeAgentOptions,
  query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { log } from '../../../util/logger'
import type { DelegationControl } from '../../delegation-registry'
import type { ToolResult } from '../../types'
import { DEFAULT_BACKGROUND_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from './shared'
import type { CodeAgentBackend, CodeAgentConfig } from './types'

function userTurn(text: string): SDKUserMessage {
  // session_id is filled in by the SDK for streaming input; the field is required by the type.
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  }
}

/**
 * The prompt as a stream rather than a string — this is what makes a run steerable.
 *
 * A string prompt closes the input the moment it is sent, so the run is sealed: whatever the
 * operator learns while it works, it cannot say. An async iterable keeps the input open, so a
 * `code_agent_steer` message becomes another user turn in the same session, with all the
 * context the delegate has already built. The generator returns when the registry closes the
 * channel, which is what lets the SDK finish instead of waiting forever for more input.
 */
async function* steerablePrompt(
  task: string,
  control: DelegationControl,
): AsyncGenerator<SDKUserMessage> {
  yield userTurn(task)
  while (true) {
    const next = await control.nextSteer()
    if (next === undefined) return
    log.info('code-agent', 'Delivering steer to the running delegation')
    yield userTurn(next)
  }
}

/** Condense one assistant message into progress lines for `code_agent_status`. */
function progressLines(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const lines: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: string; text?: string; name?: string }
    if (b.type === 'text' && b.text?.trim()) {
      lines.push(b.text.trim().slice(0, 300))
    } else if (b.type === 'tool_use' && b.name) {
      lines.push(`→ ${b.name}`)
    }
  }
  return lines
}

/**
 * Build the SDK permission callback. The Claude permission engine decides
 * which tool calls are worth gating; this routes each gated call to egirl's
 * local-model supervisor, which can accept, reject, or re-steer it.
 */
function buildCanUseTool(
  config: CodeAgentConfig,
  task: string,
  workingDir: string,
  onEscalate: (reason: string) => void,
): CanUseTool {
  const supervisor = config.permissionSupervisor
  return async (toolName, input, { signal, blockedPath, decisionReason }) => {
    if (signal.aborted) {
      return { behavior: 'deny', message: 'Aborted', interrupt: true }
    }
    if (!supervisor) {
      return { behavior: 'allow', updatedInput: input }
    }

    const decision = await supervisor.decide({
      backend: 'claude',
      kind: 'permission',
      originalTask: task,
      workingDir,
      toolName,
      toolInput: input,
      promptText: decisionReason ?? `Claude Code requests permission to use ${toolName}.`,
      ...(blockedPath ? { riskHints: [`Blocked path: ${blockedPath}`] } : {}),
    })

    if (decision.action === 'ask_user') {
      onEscalate(decision.reason)
      return {
        behavior: 'deny',
        message: `Halted: this action needs your approval. ${decision.reason}`,
        interrupt: true,
      }
    }

    // deny carries the supervisor's guidance back to Claude as the tool
    // result, which is how a re-steer (vs. a flat reject) is expressed.
    if (decision.action === 'deny') {
      return { behavior: 'deny', message: decision.answer ?? decision.reason }
    }

    // allow | choose
    return { behavior: 'allow', updatedInput: input }
  }
}

function stoppedResult(partial: string): ToolResult {
  return {
    success: false,
    output: [
      'Delegation stopped before it finished.',
      partial ? `\nWork reported before the stop:\n${partial}` : '\nNothing was reported yet.',
    ].join('\n'),
  }
}

function userApprovalResult(reason: string, partial: string): ToolResult {
  return {
    success: false,
    output: [
      'Code agent needs user approval before continuing.',
      '',
      reason,
      partial ? `\nPartial result:\n${partial}` : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

export const runClaudeCodeAgent: CodeAgentBackend = async (config, task, workingDir, control) => {
  const startTime = Date.now()
  let sessionId = ''
  let sdkTurns: number | undefined
  let manualTurns = 0
  let totalCost = 0
  let finalResult = ''
  let escalation: string | undefined

  // A background delegation is not waiting on anyone's patience, so it gets a longer ceiling
  // than the foreground default. An explicit config timeout still wins over both.
  const timeoutMs =
    config.timeoutMs ?? (control ? DEFAULT_BACKGROUND_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)
  const abortController = new AbortController()
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs)
  // `code_agent_stop` aborts the registry's signal; forward it into the one the SDK watches.
  control?.signal.addEventListener('abort', () => abortController.abort(), { once: true })

  const supervised = config.permissionSupervisor?.isActive() ?? false
  const isBypass = config.permissionMode === 'bypassPermissions'

  const options: ClaudeAgentOptions = supervised
    ? {
        // Run in a gating mode so the SDK routes tool calls through canUseTool;
        // never bypass, or the supervisor would never be consulted.
        permissionMode: isBypass ? 'default' : config.permissionMode,
        canUseTool: buildCanUseTool(config, task, workingDir, (reason) => {
          escalation = reason
        }),
        model: config.model,
        maxTurns: config.maxTurns,
        cwd: workingDir,
        abortController,
      }
    : {
        permissionMode: isBypass ? 'bypassPermissions' : 'default',
        ...(isBypass && { allowDangerouslySkipPermissions: true }),
        model: config.model,
        maxTurns: config.maxTurns,
        cwd: workingDir,
        abortController,
      }

  try {
    const prompt = control ? steerablePrompt(task, control) : task
    let closed = false

    for await (const message of query({ prompt, options })) {
      if (abortController.signal.aborted) break
      if (!('type' in message)) continue

      switch (message.type) {
        case 'system': {
          if ('session_id' in message) {
            sessionId = message.session_id as string
            log.debug('code-agent', `Session: ${sessionId.slice(0, 8)}...`)
          }
          break
        }

        case 'result': {
          const resultMsg = message as {
            result?: string
            num_turns?: number
            total_cost_usd?: number
          }
          finalResult = resultMsg.result ?? ''
          sdkTurns = resultMsg.num_turns
          totalCost = resultMsg.total_cost_usd ?? totalCost
          control?.onStats({ costUsd: totalCost, turns: sdkTurns ?? manualTurns })
          // With the input stream still open the SDK will wait for another turn rather than
          // end, so a steerable run has to decide here: close and finish, or take the steer
          // that arrived while this turn was landing and keep working.
          if (control) {
            closed = control.closeSteering()
            if (!closed) control.onProgress('[steer accepted — continuing]')
          }
          break
        }
      }

      // Count assistant turns as fallback if SDK doesn't report them
      if ('message' in message && message.message) {
        const msg = message.message as { role?: string; content?: unknown }
        if (msg.role === 'assistant') {
          manualTurns++
          if (control) for (const line of progressLines(msg.content)) control.onProgress(line)
        }
      }

      if (closed) break
    }
  } catch (error) {
    clearTimeout(timeoutId)
    if (escalation) return userApprovalResult(escalation, finalResult)
    if (control?.signal.aborted) return stoppedResult(finalResult)
    const isTimeout = error instanceof DOMException && error.name === 'AbortError'
    const msg = isTimeout
      ? `Code agent timed out after ${(timeoutMs / 1000).toFixed(0)}s`
      : error instanceof Error
        ? error.message
        : String(error)
    log.error('code-agent', `Task failed: ${msg}`)
    return {
      success: false,
      output: `Code agent error: ${msg}`,
    }
  }
  clearTimeout(timeoutId)

  if (escalation) return userApprovalResult(escalation, finalResult)

  // Aborting mid-stream ends the loop through `break` rather than a throw, so the stop has to
  // be checked here too — otherwise a run the operator killed reports as a clean completion.
  if (control?.signal.aborted) return stoppedResult(finalResult)
  if (abortController.signal.aborted && !finalResult) {
    return {
      success: false,
      output: `Code agent timed out after ${(timeoutMs / 1000).toFixed(0)}s`,
    }
  }

  const turns = sdkTurns ?? manualTurns
  const durationMs = Date.now() - startTime
  const durationSec = (durationMs / 1000).toFixed(1)

  log.info('code-agent', `Completed in ${durationSec}s | ${turns} turns | $${totalCost.toFixed(4)}`)

  if (!finalResult) {
    return {
      success: false,
      output: `Code agent completed but returned no result (${turns} turns, ${durationSec}s)`,
    }
  }

  const metadata = `[code_agent: ${turns} turns | $${totalCost.toFixed(4)} | ${durationSec}s | session: ${sessionId.slice(0, 8)}]`

  return {
    success: true,
    output: `${finalResult}\n\n${metadata}`,
  }
}
