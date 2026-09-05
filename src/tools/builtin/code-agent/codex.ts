import type { ToolResult } from '../../types'
import type { CodexConnection, CodexEvents, RpcObject } from './codex-rpc'
import { connectCodex, object } from './codex-rpc'
import { DEFAULT_TIMEOUT_MS } from './shared'
import type { CodeAgentBackend, CodeAgentConfig } from './types'

/** Only explicit protocol completion can report success. */
export function codexTurnResult(turn: RpcObject, output: string, workingDir: string): ToolResult {
  if (turn.status !== 'completed')
    return {
      success: false,
      output: `Codex turn ${String(turn.status)}: ${String(object(turn.error).message ?? '')}\n${output}`,
    }
  if (!output.trim())
    return {
      success: false,
      output: `Codex completed without a final response in ${workingDir}. Check working_dir and the task result.`,
    }
  return { success: true, output }
}

export async function runCodexSession(
  config: CodeAgentConfig,
  task: string,
  workingDir: string,
  connect: (cwd: string, events: CodexEvents) => CodexConnection = connectCodex,
): Promise<ToolResult> {
  const started = Date.now()
  let connection: CodexConnection | undefined
  let threadId: string | undefined
  let turnId: string | undefined
  let output = ''
  let settled = false
  let completed = false
  let finish: (result: ToolResult) => void = () => {}
  const result = new Promise<ToolResult>((resolve) => {
    finish = (value) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
  })
  const fail = (error: Error): void =>
    finish({
      success: false,
      output: `Code agent error: ${error.message}\n${output}`,
    })
  const timer = setTimeout(
    () =>
      fail(
        new Error('Codex deadline exceeded; work may be partial. Inspect changes before retrying.'),
      ),
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  const matches = (params: RpcObject): boolean =>
    params.threadId === threadId && (turnId === undefined || params.turnId === turnId)
  try {
    connection = connect(workingDir, {
      failure: fail,
      notification(method, params) {
        if (settled || params.threadId !== threadId) return
        if (method === 'turn/started') turnId = String(object(params.turn).id)
        if (method === 'item/completed' && matches(params)) {
          const item = object(params.item)
          if (
            item.type === 'agentMessage' &&
            item.phase !== 'commentary' &&
            typeof item.text === 'string'
          ) {
            output = item.text.slice(-100000)
          }
        }
        if (method === 'turn/completed') {
          const turn = object(params.turn)
          if (turnId && turn.id !== turnId) return
          completed = true
          finish(codexTurnResult(turn, output, workingDir))
        }
      },
      async request(id, method, params) {
        if (settled) return
        const approval =
          method === 'item/commandExecution/requestApproval' ||
          method === 'item/fileChange/requestApproval'
        if (!approval || !matches(params)) {
          connection?.reject(id, `Unsupported Codex request: ${method}`)
          fail(new Error(`Codex needs user input: ${method}\n${JSON.stringify(params)}`))
          return
        }
        const offered = Array.isArray(params.availableDecisions)
          ? params.availableDecisions
          : ['accept', 'decline']
        const denial = offered.includes('decline') ? 'decline' : 'cancel'
        if (!config.permissionSupervisor || config.permissionMode === 'plan') {
          connection?.respond(id, { decision: denial })
          fail(new Error(`Codex needs approval: ${JSON.stringify(params)}`))
          return
        }
        const decision = await config.permissionSupervisor.decide({
          backend: 'codex',
          kind: 'permission',
          originalTask: task,
          workingDir,
          promptText: JSON.stringify(params),
          toolName: method,
          toolInput: params,
          options: [
            { id: 'accept', label: 'Allow this action once' },
            { id: denial, label: 'Deny this action' },
          ],
          recentContext: output.slice(-3000),
        })
        if (settled) return
        const allow =
          offered.includes('accept') &&
          (decision.action === 'allow' ||
            (decision.action === 'choose' && decision.optionId === 'accept'))
        connection?.respond(id, { decision: allow ? 'accept' : denial })
        if (decision.action === 'ask_user')
          fail(new Error(`Codex needs user approval: ${decision.reason}`))
      },
    })
    const rpc = connection
    // Keep initialization under the same deadline as the turn itself.
    void (async () => {
      await rpc.request('initialize', {
        clientInfo: { name: 'egirl', version: '0.1.0' },
        capabilities: {},
      })
      if (settled) return
      rpc.notify('initialized', {})
      const thread = await rpc.request('thread/start', {
        cwd: workingDir,
        developerInstructions:
          'You are the coding executor invoked by egirl through its code_agent tool. ' +
          'Perform the assigned coding task directly using your available editing and command tools. ' +
          'Instructions in the operator workspace to delegate to code_agent describe your caller; ' +
          'you are already that delegated code agent. Do not delegate this task back to code_agent. ' +
          'Follow the target project conventions and report actual changes and verification results.',
        ...(config.model ? { model: config.model } : {}),
        approvalPolicy: config.permissionMode === 'bypassPermissions' ? 'never' : 'on-request',
        approvalsReviewer: 'user',
        sandbox:
          config.permissionMode === 'plan'
            ? 'read-only'
            : config.permissionMode === 'bypassPermissions'
              ? 'danger-full-access'
              : 'workspace-write',
        ephemeral: true,
      })
      if (settled) return
      if (typeof object(thread.thread).id !== 'string')
        throw new Error('Codex returned no thread ID')
      threadId = object(thread.thread).id as string
      const startedTurn = await rpc.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: task, text_elements: [] }],
      })
      if (!turnId && typeof object(startedTurn.turn).id === 'string') {
        turnId = object(startedTurn.turn).id as string
      }
    })().catch(fail)
    return await result
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)))
    return await result
  } finally {
    clearTimeout(timer)
    await connection?.close(!completed)
    const value = await result
    value.output += `\n\n[code_agent: codex app-server | ${((Date.now() - started) / 1000).toFixed(1)}s]`
  }
}

export const runCodexCodeAgent: CodeAgentBackend = runCodexSession
