import {
  type CanUseTool,
  type Options as ClaudeAgentOptions,
  query,
} from '@anthropic-ai/claude-agent-sdk'
import type { PermissionSupervisor } from '../../../permissions/supervisor'
import { log } from '../../../util/logger'
import type { ToolResult } from '../../types'
import { DEFAULT_TIMEOUT_MS, withImagePaths } from './shared'
import { ActionLog, formatTimeoutReport } from './timeout-report'
import type { CodeAgentBackend, CodeAgentConfig, CodeAgentRunOptions } from './types'

const ABORTED = Symbol('aborted')

/** Resolve with `work`, or with ABORTED as soon as any signal fires — whichever is first. */
function raceAbort<T>(work: Promise<T>, signals: AbortSignal[]): Promise<T | typeof ABORTED> {
  if (signals.some((s) => s.aborted)) return Promise.resolve(ABORTED)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      resolve(ABORTED)
    }
    const cleanup = (): void => {
      for (const s of signals) s.removeEventListener('abort', onAbort)
    }
    for (const s of signals) s.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

/**
 * Build the SDK permission callback. The Claude permission engine decides
 * which tool calls are worth gating; this routes each gated call to egirl's
 * local-model supervisor, which can accept, reject, or re-steer it.
 *
 * `runSignal` is the run's own abort (timeout). A supervisor decision takes seconds; if the run
 * is aborted meanwhile, answer at once instead of letting a late decision reach a dead process.
 */
export function buildCanUseTool(
  supervisor: PermissionSupervisor | undefined,
  task: string,
  workingDir: string,
  onEscalate: (reason: string) => void,
  runSignal?: AbortSignal,
): CanUseTool {
  return async (toolName, input, { signal, blockedPath, decisionReason }) => {
    const signals = runSignal ? [signal, runSignal] : [signal]
    const aborted = { behavior: 'deny', message: 'Aborted', interrupt: true } as const
    if (signals.some((s) => s.aborted)) return aborted
    if (!supervisor) {
      return { behavior: 'allow', updatedInput: input }
    }

    const decision = await raceAbort(
      supervisor.decide({
        backend: 'claude',
        kind: 'permission',
        originalTask: task,
        workingDir,
        toolName,
        toolInput: input,
        promptText: decisionReason ?? `Claude Code requests permission to use ${toolName}.`,
        ...(blockedPath ? { riskHints: [`Blocked path: ${blockedPath}`] } : {}),
      }),
      signals,
    )
    if (decision === ABORTED) return aborted

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

type QueryFn = typeof query

/**
 * Safety net for a late SDK write after our own abort.
 *
 * Observed on claude-agent-sdk 0.2.39: the run hit timeout_ms and was aborted while a permission
 * decision was still pending; when it resolved, the SDK wrote the control response to the aborted
 * process, its transport threw "Operation aborted" from an un-awaited handleControlRequest, and
 * the unhandled rejection killed egirl. 0.3.x catches that write itself and canUseTool now
 * answers immediately on abort, but a timed-out run must never take the process down, so for a
 * short window after one of our aborts exactly that rejection is logged instead of being fatal.
 * Anything else keeps the default crash behaviour when no other listener is installed.
 */
const LATE_ABORT_GRACE_MS = 60_000
let lateAbortWindows = 0

export function isLateSdkAbort(reason: unknown): boolean {
  return (
    reason instanceof Error &&
    reason.message === 'Operation aborted' &&
    /claude-agent-sdk/.test(reason.stack ?? '')
  )
}

function onUnhandledRejection(reason: unknown): void {
  if (isLateSdkAbort(reason)) {
    log.warn('code-agent', 'Ignored a late Claude SDK write after the run was aborted')
    return
  }
  // Not ours. If no one else handles rejections, do what the runtime would have done without
  // this listener: report it and exit (rethrowing from here is not fatal under Bun).
  if (process.listenerCount('unhandledRejection') === 1) {
    console.error(reason)
    process.exit(1)
  }
}

/** Exported for tests. */
export function guardLateSdkAbort(graceMs = LATE_ABORT_GRACE_MS): void {
  if (lateAbortWindows++ === 0) process.on('unhandledRejection', onUnhandledRejection)
  setTimeout(() => {
    if (--lateAbortWindows === 0) process.off('unhandledRejection', onUnhandledRejection)
  }, graceMs).unref?.()
}

/** Pull text and tool calls out of an SDK assistant message. */
function readAssistant(
  message: unknown,
  actions: ActionLog,
): { text: string; isAssistant: boolean } {
  const msg = (message as { message?: { role?: string; content?: unknown } }).message
  if (msg?.role !== 'assistant') return { text: '', isAssistant: false }
  const texts: string[] = []
  if (Array.isArray(msg.content)) {
    for (const block of msg.content as {
      type?: string
      text?: string
      name?: string
      input?: unknown
    }[]) {
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      if (block.type === 'tool_use' && typeof block.name === 'string')
        actions.add(block.name, block.input)
    }
  }
  return { text: texts.join('\n').trim(), isAssistant: true }
}

export async function runClaudeSession(
  config: CodeAgentConfig,
  task: string,
  workingDir: string,
  images?: string[],
  runOptions: CodeAgentRunOptions = {},
  queryFn: QueryFn = query,
): Promise<ToolResult> {
  const startTime = Date.now()
  const resume = runOptions.resumeSession
  let sessionId = resume ?? ''
  let sdkTurns: number | undefined
  let manualTurns = 0
  let totalCost = 0
  let finalResult = ''
  let lastText = ''
  let escalation: string | undefined
  const actions = new ActionLog()

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const abortController = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    guardLateSdkAbort()
    abortController.abort()
  }, timeoutMs)

  const supervised = config.permissionSupervisor?.isActive() ?? false
  const isBypass = config.permissionMode === 'bypassPermissions'

  const options: ClaudeAgentOptions = supervised
    ? {
        // Run in a gating mode so the SDK routes tool calls through canUseTool;
        // never bypass, or the supervisor would never be consulted. In 'auto' Claude Code's
        // own classifier settles routine calls and only the ones it can't decide come here.
        permissionMode: isBypass ? 'default' : config.permissionMode,
        canUseTool: buildCanUseTool(
          config.permissionSupervisor,
          task,
          workingDir,
          (reason) => {
            escalation = reason
          },
          abortController.signal,
        ),
        model: config.model,
        maxTurns: config.maxTurns,
        cwd: workingDir,
        abortController,
      }
    : {
        permissionMode: isBypass
          ? 'bypassPermissions'
          : config.permissionMode === 'auto'
            ? 'auto'
            : 'default',
        ...(isBypass && { allowDangerouslySkipPermissions: true }),
        model: config.model,
        maxTurns: config.maxTurns,
        cwd: workingDir,
        abortController,
      }
  // Continue the same session: its history is reloaded and the task is the next instruction.
  if (resume) options.resume = resume

  const timeoutReport = async (): Promise<ToolResult> => {
    const output = await formatTimeoutReport({
      provider: 'claude',
      timeoutMs,
      workingDir,
      turns: sdkTurns ?? manualTurns,
      actions,
      lastMessage: finalResult || lastText,
      sessionId: sessionId || undefined,
    })
    log.error('code-agent', `Task timed out after ${(timeoutMs / 1000).toFixed(0)}s`)
    return { success: false, output }
  }

  try {
    for await (const message of queryFn({ prompt: withImagePaths(task, images), options })) {
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

      // Count assistant turns as fallback if SDK doesn't report them, and keep what the agent
      // said and did so a timeout can report it.
      const { text, isAssistant } = readAssistant(message, actions)
      if (isAssistant) manualTurns++
      if (text) lastText = text
    }
  } catch (error) {
    clearTimeout(timeoutId)
    if (escalation) return userApprovalResult(escalation, finalResult)
    // The SDK surfaces our abort as its own "Claude Code process aborted by user" error, not an
    // AbortError, so the model was told a person had stopped the run. Our signal is the truth.
    if (timedOut || abortController.signal.aborted) return timeoutReport()
    const msg = error instanceof Error ? error.message : String(error)
    log.error('code-agent', `Task failed: ${msg}`)
    return {
      success: false,
      output: `Code agent error: ${msg}`,
    }
  }
  clearTimeout(timeoutId)

  if (escalation) return userApprovalResult(escalation, finalResult)
  if (timedOut) return timeoutReport()

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

  const metadata = `[code_agent: ${turns} turns | $${totalCost.toFixed(4)} | ${durationSec}s | session: ${sessionId}]`

  return {
    success: true,
    output: `${finalResult}\n\n${metadata}`,
  }
}

export const runClaudeCodeAgent: CodeAgentBackend = (config, task, workingDir, images, options) =>
  runClaudeSession(config, task, workingDir, images, options)
