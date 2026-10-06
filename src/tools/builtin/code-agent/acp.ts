import * as acp from '@agentclientprotocol/sdk'
import { errorMessage } from '../../../util/errors'
import { log } from '../../../util/logger'
import type { ToolResult } from '../../types'
import { type AcpConnect, type AcpTransport, spawnAcpAgent } from './acp-process'
import { DEFAULT_TIMEOUT_MS, withImagePaths } from './shared'
import type { CodeAgentBackend, CodeAgentConfig } from './types'

/**
 * The `acp` provider: any agent that speaks the Agent Client Protocol (Gemini CLI natively,
 * Claude Code and Codex through adapters, opencode) run as a code agent. egirl is the client:
 * initialize, one session in the working dir, one prompt carrying the task. The agent's message
 * text is the tool result; its permission requests go to the PermissionSupervisor.
 *
 * egirl advertises no fs or terminal capabilities, so the agent uses its own tools for both.
 */

/** How long a cancelled turn gets to wind down before the agent is killed. */
const CANCEL_GRACE_MS = 3000

type OptionKind = acp.PermissionOptionKind
const ALLOW: OptionKind[] = ['allow_once', 'allow_always']
const REJECT: OptionKind[] = ['reject_once', 'reject_always']

// Tool kinds that change nothing. Without a supervisor these are what the restrictive
// permission modes still let through.
const READ_ONLY_KINDS = new Set<string>(['read', 'search', 'think'])

function optionOf(options: acp.PermissionOption[], kinds: OptionKind[]): string | undefined {
  for (const kind of kinds) {
    const option = options.find((o) => o.kind === kind)
    if (option) return option.optionId
  }
  return undefined
}

/** What permission_mode means when nobody supervises: the same reading the other backends use. */
function modeAllows(mode: CodeAgentConfig['permissionMode'], kind: string | undefined): boolean {
  if (mode === 'bypassPermissions') return true
  if (kind && READ_ONLY_KINDS.has(kind)) return true
  return mode === 'acceptEdits' && kind === 'edit'
}

type PermissionAnswer = { optionId: string } | { cancel: true } | { escalate: string }

/**
 * Answer one `session/request_permission`. A supervisor approval is always a one-time grant:
 * an "always allow" option would persist in the agent's own settings, which is not the
 * supervisor's call to make for every future run.
 */
export async function decideAcpPermission(
  config: CodeAgentConfig,
  task: string,
  workingDir: string,
  request: acp.RequestPermissionRequest,
  recentText: string,
): Promise<PermissionAnswer> {
  const { options, toolCall } = request
  const answer = (allow: boolean): PermissionAnswer => {
    const optionId = optionOf(options, allow ? ALLOW : REJECT)
    return optionId ? { optionId } : { cancel: true }
  }

  const supervisor = config.permissionSupervisor
  if (!supervisor?.isActive())
    return answer(modeAllows(config.permissionMode, toolCall.kind ?? undefined))

  const title = toolCall.title ?? toolCall.kind ?? 'a tool call'
  const decision = await supervisor.decide({
    backend: 'acp',
    kind: 'permission',
    originalTask: task,
    workingDir,
    toolName: toolCall.title ?? toolCall.kind ?? undefined,
    toolInput: toolCall.rawInput,
    promptText: `The ACP agent requests permission (${toolCall.kind ?? 'other'}): ${title}`,
    options: options.map((o) => ({ id: o.optionId, label: o.name })),
    recentContext: recentText.slice(-3000),
  })

  if (decision.action === 'ask_user') return { escalate: decision.reason }
  if (decision.action === 'allow') return answer(true)
  if (decision.action === 'choose') {
    // A choice that names no offered option is malformed: deny, as the codex backend does.
    const chosen = options.find((o) => o.optionId === decision.optionId)
    if (!chosen) log.warn('code-agent', `acp supervisor chose unknown option; denying`)
    return answer(chosen !== undefined && ALLOW.includes(chosen.kind))
  }
  // deny, and anything unrecognised, fails closed.
  return answer(false)
}

export async function runAcpSession(
  config: CodeAgentConfig,
  task: string,
  workingDir: string,
  images: string[] = [],
  connect: AcpConnect = spawnAcpAgent,
): Promise<ToolResult> {
  const started = Date.now()
  const command = config.acpCommand
  if (!command?.length) {
    return {
      success: false,
      output:
        'Code agent error: ACP agent failed to start: set acp_command in [channels.code_agent]',
    }
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let transport: AcpTransport
  try {
    transport = connect(command, workingDir)
  } catch (error) {
    return { success: false, output: `Code agent error: ${errorMessage(error)}` }
  }

  let text = ''
  let toolCalls = 0
  let sessionId: string | undefined
  let escalation: string | undefined
  let timedOut = false
  let completed = false
  let cancelTurn: () => void = () => {}

  const app = acp
    .client({ name: 'egirl' })
    .onNotification('session/update', ({ params }) => {
      if (params.sessionId !== sessionId) return
      const update = params.update
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        text = (text + update.content.text).slice(-100_000)
      } else if (update.sessionUpdate === 'tool_call') {
        toolCalls++
      }
    })
    .onRequest('session/request_permission', async ({ params }) => {
      // Once the turn is being cancelled, the protocol requires `cancelled` for anything pending.
      if (escalation || timedOut) return { outcome: { outcome: 'cancelled' } }
      const answer = await decideAcpPermission(config, task, workingDir, params, text)
      if ('escalate' in answer) {
        escalation = answer.escalate
        cancelTurn()
        return { outcome: { outcome: 'cancelled' } }
      }
      if ('cancel' in answer) return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId: answer.optionId } }
    })

  const turn = app.connectWith(transport.stream, async (cx) => {
    await cx.request('initialize', {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'egirl', version: '0.1.0' },
    })
    const session = await cx.request('session/new', { cwd: workingDir, mcpServers: [] })
    sessionId = session.sessionId
    cancelTurn = () => {
      cx.notify('session/cancel', { sessionId: session.sessionId }).catch(() => {})
    }
    return cx.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: withImagePaths(task, images) }],
    })
  })

  // Deadline: ask the agent to stop, then stop it. A killed agent ends the stream, which
  // rejects the pending prompt; the race below covers an agent that ignores even that.
  let stop: (() => void) | undefined
  const stopped = new Promise<'stopped'>((resolve) => {
    stop = () => resolve('stopped')
  })
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const deadline = setTimeout(() => {
    timedOut = true
    cancelTurn()
    graceTimer = setTimeout(
      () => {
        void transport.close(true)
        stop?.()
      },
      Math.min(CANCEL_GRACE_MS, timeoutMs),
    )
  }, timeoutMs)

  let response: acp.PromptResponse | undefined
  let failure: string | undefined
  try {
    const outcome = await Promise.race([turn, stopped])
    if (outcome !== 'stopped') {
      response = outcome
      completed = true
    }
  } catch (error) {
    failure = errorMessage(error)
  } finally {
    clearTimeout(deadline)
    clearTimeout(graceTimer)
    turn.catch(() => {}) // a turn that lost the race may still reject; nothing to report
    await transport.close(!completed)
  }

  const durationSec = ((Date.now() - started) / 1000).toFixed(1)
  const partial = text.trim() ? `\n\nPartial result:\n${text}` : ''

  if (escalation) {
    return {
      success: false,
      output: `Code agent needs user approval before continuing.\n\n${escalation}${partial}`,
    }
  }
  if (timedOut) {
    log.warn('code-agent', `acp agent timed out after ${durationSec}s`)
    return {
      success: false,
      output: `Code agent timed out after ${(timeoutMs / 1000).toFixed(0)}s; work may be partial. Inspect changes before retrying.${partial}`,
    }
  }
  if (failure !== undefined || !response) {
    const stderr = transport.stderr()
    log.error('code-agent', `acp task failed: ${failure}`)
    return {
      success: false,
      output: `Code agent error: ${failure ?? 'no response'}${stderr ? `\n${stderr}` : ''}${partial}`,
    }
  }
  if (response.stopReason !== 'end_turn') {
    return {
      success: false,
      output: `Code agent stopped (${response.stopReason}) before finishing.${partial}`,
    }
  }
  if (!text.trim()) {
    return {
      success: false,
      output: `ACP agent produced no output in ${workingDir}. Check working_dir and acp_command.`,
    }
  }

  log.info('code-agent', `acp completed in ${durationSec}s | ${toolCalls} tool calls`)
  return {
    success: true,
    output: `${text}\n\n[code_agent: acp ${command.join(' ').slice(0, 80)} | ${toolCalls} tool calls | ${durationSec}s]`,
  }
}

export const runAcpCodeAgent: CodeAgentBackend = (config, task, workingDir, images) =>
  runAcpSession(config, task, workingDir, images)
