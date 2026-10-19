import type { CodexConnection, CodexEvents, RpcObject } from '../tools/builtin/code-agent/codex-rpc'
import { object } from '../tools/builtin/code-agent/codex-rpc'
import { errorMessage } from '../util/errors'
import {
  CODEX_CAPABILITIES,
  codexDynamicTools,
  codexThreadSettings,
  codexToolResponse,
  codexTurnParams,
  isStaleThread,
} from './codex-protocol'
import { emptyOutcome, type HarnessOutcome, type HarnessTurn } from './hosted-types'

export type ConnectFn = (cwd: string, events: CodexEvents) => CodexConnection

/** A turn in flight, for steering a message into it. */
export interface LiveTurn {
  connection: CodexConnection
  threadId: string
  turnId: string
}

export interface CodexTurnArgs {
  turn: HarnessTurn
  connect: ConnectFn
  cwd: string
  instructions: string
  model?: string
  /** The thread to continue; absent starts a new one. */
  resumeId?: string
  /** The thread this turn runs on, as soon as it is known, so the next turn can resume it. */
  onThread(threadId: string): void
  /** The turn is running (a LiveTurn) or over (undefined). */
  onLive(live: LiveTurn | undefined): void
  /** Turn cap: tool calls served before the turn is stopped. Undefined runs to its own end. */
  maxToolCalls?: number
}

export interface CodexTurnResult {
  outcome: HarnessOutcome
  /** The resume id had no rollout behind it: nothing ran, start a new thread. */
  staleResume: boolean
}

/** How long an interrupted turn gets to report itself before the process is killed. */
const INTERRUPT_GRACE_MS = 3_000

/**
 * One user turn on `codex app-server`: a process for the turn, a new or resumed thread, the
 * turn itself, and every egirl tool call Codex makes served back over the same pipe.
 */
export function runCodexTurn(args: CodexTurnArgs): Promise<CodexTurnResult> {
  const { turn } = args
  const signal = turn.controller.signal
  const outcome = emptyOutcome()
  const thinking: string[] = []
  let threadId: string | undefined
  let turnId: string | undefined
  let finalText = ''
  let lastText = ''
  let calls = 0
  let limitHit = false
  let completed = false
  let staleResume = false
  let settled = false
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let resolveResult: (result: CodexTurnResult) => void = () => {}
  const result = new Promise<CodexTurnResult>((resolve) => {
    resolveResult = resolve
  })

  const interrupt = (): void => {
    if (threadId && turnId)
      connection.request('turn/interrupt', { threadId, turnId }).catch(() => {})
  }
  const onAbort = (): void => {
    if (!turnId) {
      finish()
      return
    }
    interrupt()
    graceTimer = setTimeout(finish, INTERRUPT_GRACE_MS)
  }
  function finish(): void {
    if (settled) return
    settled = true
    args.onLive(undefined)
    signal.removeEventListener('abort', onAbort)
    clearTimeout(graceTimer)
    outcome.content = outcome.content || finalText || lastText
    outcome.thinking = thinking.join('')
    void connection.close(!completed).finally(() => resolveResult({ outcome, staleResume }))
  }

  const events: CodexEvents = {
    failure(error) {
      if (!signal.aborted && !completed) outcome.error ??= error.message
      finish()
    },
    notification(method, params) {
      if (settled || !threadId || params.threadId !== threadId) return
      if (method === 'turn/started') {
        turnId ??= String(object(params.turn).id)
        args.onLive({ connection, threadId, turnId })
        return
      }
      if (turnId && params.turnId !== undefined && params.turnId !== turnId) return
      onNotification(method, params)
    },
    async request(id, method, params) {
      if (method !== 'item/tool/call' || params.threadId !== threadId) {
        // Not expected with Codex's own tools off; decline rather than leave the turn hanging.
        if (method.endsWith('requestApproval')) connection.respond(id, { decision: 'decline' })
        else connection.reject(id, `egirl does not handle ${method}`)
        return
      }
      const served = await turn.callTool(String(params.tool), object(params.arguments))
      if (settled) return
      connection.respond(id, codexToolResponse(served.result, served.note))
      calls++
      if (args.maxToolCalls !== undefined && calls >= args.maxToolCalls && !limitHit) {
        limitHit = true
        interrupt()
      }
    },
  }

  function onNotification(method: string, params: RpcObject): void {
    const delta = typeof params.delta === 'string' ? params.delta : ''
    if (method === 'item/agentMessage/delta' && delta) turn.events.onToken?.(delta)
    if (
      (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') &&
      delta
    ) {
      thinking.push(delta)
      turn.events.onThinkingToken?.(delta)
    }
    const item = object(params.item)
    if (method === 'item/started' && item.type === 'dynamicToolCall') {
      outcome.sawAssistant = true
      turn.events.onToolCallStart?.([
        { id: String(item.id), name: String(item.tool), arguments: object(item.arguments) },
      ])
    }
    if (method === 'item/completed' && item.type === 'agentMessage') {
      outcome.sawAssistant = true
      const text = typeof item.text === 'string' ? item.text : ''
      if (text) lastText = text
      if (text && item.phase !== 'commentary') finalText = text
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = object(params.tokenUsage)
      const last = object(usage.last)
      const input = Number(last.inputTokens) || 0
      outcome.turns++
      outcome.usage.input_tokens += input
      outcome.usage.output_tokens += Number(last.outputTokens) || 0
      outcome.contextTokens = input
      if (typeof usage.modelContextWindow === 'number') {
        outcome.contextWindow = usage.modelContextWindow
      }
    }
    if (method === 'error' && params.willRetry !== true) {
      outcome.error = String(object(params.error).message ?? 'Codex reported an error')
    }
    if (method === 'turn/completed') {
      const ended = object(params.turn)
      completed = true
      if (ended.status === 'failed') {
        outcome.error = String(object(ended.error).message ?? 'Codex turn failed')
      } else if (ended.status === 'interrupted' && limitHit) {
        outcome.turnLimitReached = true
      } else if (ended.status === 'completed') {
        outcome.error = undefined
      }
      finish()
    }
  }

  const connection = args.connect(args.cwd, events)
  signal.addEventListener('abort', onAbort, { once: true })
  void start().catch((error) => {
    outcome.error ??= errorMessage(error)
    finish()
  })
  return result

  async function start(): Promise<void> {
    await connection.request('initialize', {
      clientInfo: { name: 'egirl', title: null, version: '0.1.0' },
      capabilities: CODEX_CAPABILITIES,
    })
    connection.notify('initialized', {})
    const settings = codexThreadSettings(args)
    let thread: RpcObject
    if (args.resumeId) {
      try {
        thread = await connection.request('thread/resume', {
          ...settings,
          threadId: args.resumeId,
          excludeTurns: true,
        })
      } catch (error) {
        if (!isStaleThread(errorMessage(error))) throw error
        staleResume = true
        outcome.error = errorMessage(error)
        finish()
        return
      }
    } else {
      thread = await connection.request('thread/start', {
        ...settings,
        dynamicTools: codexDynamicTools(turn.tools),
        environments: [],
        ephemeral: false,
      })
    }
    const id = object(thread.thread).id
    if (typeof id !== 'string') throw new Error('Codex returned no thread id')
    threadId = id
    args.onThread(id)
    if (settled || signal.aborted) {
      finish()
      return
    }
    const started = await connection.request(
      'turn/start',
      codexTurnParams({
        threadId: id,
        text: turn.body,
        imagePaths: turn.imagePaths,
        thinking: turn.thinking,
      }),
    )
    if (!turnId && typeof object(started.turn).id === 'string') {
      turnId = object(started.turn).id as string
      if (!settled) args.onLive({ connection, threadId: id, turnId })
    }
    if (signal.aborted) onAbort()
  }
}
