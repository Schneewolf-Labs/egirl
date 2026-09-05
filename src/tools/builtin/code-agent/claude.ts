import {
  type CanUseTool,
  type Options as ClaudeAgentOptions,
  query,
} from '@anthropic-ai/claude-agent-sdk'
import type { PermissionSupervisor } from '../../../permissions/supervisor'
import { log } from '../../../util/logger'
import type { ToolResult } from '../../types'
import { DEFAULT_TIMEOUT_MS } from './shared'
import type { CodeAgentBackend } from './types'

/**
 * Build the SDK permission callback. The Claude permission engine decides
 * which tool calls are worth gating; this routes each gated call to egirl's
 * local-model supervisor, which can accept, reject, or re-steer it.
 */
export function buildCanUseTool(
  supervisor: PermissionSupervisor | undefined,
  task: string,
  workingDir: string,
  onEscalate: (reason: string) => void,
): CanUseTool {
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

export const runClaudeCodeAgent: CodeAgentBackend = async (config, task, workingDir) => {
  const startTime = Date.now()
  let sessionId = ''
  let sdkTurns: number | undefined
  let manualTurns = 0
  let totalCost = 0
  let finalResult = ''
  let escalation: string | undefined

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const abortController = new AbortController()
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs)

  const supervised = config.permissionSupervisor?.isActive() ?? false
  const isBypass = config.permissionMode === 'bypassPermissions'

  const options: ClaudeAgentOptions = supervised
    ? {
        // Run in a gating mode so the SDK routes tool calls through canUseTool;
        // never bypass, or the supervisor would never be consulted.
        permissionMode: isBypass ? 'default' : config.permissionMode,
        canUseTool: buildCanUseTool(config.permissionSupervisor, task, workingDir, (reason) => {
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
    for await (const message of query({ prompt: task, options })) {
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
          break
        }
      }

      // Count assistant turns as fallback if SDK doesn't report them
      if ('message' in message && message.message) {
        const msg = message.message as { role?: string }
        if (msg.role === 'assistant') {
          manualTurns++
        }
      }
    }
  } catch (error) {
    clearTimeout(timeoutId)
    if (escalation) return userApprovalResult(escalation, finalResult)
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
