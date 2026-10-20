import type { AgentContext } from '../agent/context'
import { publish } from '../agent/session-events'
import type { ContextStatus } from '../agent/status'
import type { AgentLoopOptions, AgentResponse } from '../agent/types'
import type { RuntimeConfig } from '../config'
import type { ThinkingConfig } from '../providers/types'
import { connectCodex } from '../tools/builtin/code-agent/codex-rpc'
import { errorMessage } from '../util/errors'
import { log } from '../util/logger'
import { type ConnectFn, type LiveTurn, runCodexTurn } from './codex-turn'
import { HostedSession, type HostedSessionDeps } from './hosted'
import type { HarnessOutcome, HarnessTurn } from './hosted-types'
import type { SessionMap } from './session-map'
import type { Operator } from './types'

/**
 * Codex as the operator: a thread on `codex app-server`, on the user's own ChatGPT login,
 * whose only tools are egirl's.
 *
 * The same shape as the Claude operator. The hosted session (./hosted) supplies the workspace
 * prompt, recall, extraction, the conversation mirror and every tool call through egirl's
 * executor; this file is only the Codex half. egirl's tools are Codex dynamic tools, called back
 * over the app-server's own JSON-RPC pipe, so no MCP server is involved. Codex's shell tool and
 * environment are switched off, so it cannot act except through them.
 *
 * Unlike the Claude SDK, app-server can take a message into a running turn (`turn/steer`), so
 * `inject` works here as it does on the local loop.
 */

export interface CodexOperatorDeps extends HostedSessionDeps {
  sessions: SessionMap
  /** Start a new thread rather than resume the stored one (a task run that begins clean). */
  isFresh?: boolean
  /** Spawns app-server; tests hand in a fake connection. */
  connect?: ConnectFn
}

/** Until app-server reports the model's window, /context measures against this estimate. */
const CODEX_CONTEXT_TOKENS = 200_000

export class CodexOperator implements Operator {
  private session: HostedSession
  private config: RuntimeConfig
  private sessions: SessionMap
  private connect: ConnectFn
  private live: LiveTurn | undefined

  constructor(deps: CodexOperatorDeps) {
    this.config = deps.config
    this.sessions = deps.sessions
    this.connect = deps.connect ?? ((cwd, events) => connectCodex(cwd, events))
    this.session = new HostedSession(deps, this, 'codex', CODEX_CONTEXT_TOKENS)
    if (deps.isFresh) this.sessions.delete(deps.sessionId)
  }

  run(message: string, options: AgentLoopOptions = {}): Promise<AgentResponse> {
    return this.session.run(message, options, (turn) => this.drive(turn))
  }

  interrupt(): boolean {
    return this.session.interrupt()
  }

  /** Steer a message into the running turn; Codex reads it at its next step. */
  inject(message: string): boolean {
    const live = this.live
    if (!live) return false
    live.connection
      .request('turn/steer', {
        threadId: live.threadId,
        expectedTurnId: live.turnId,
        input: [{ type: 'text', text: message, text_elements: [] }],
      })
      .catch((error) =>
        log.warn('operator', `Codex did not take the message: ${errorMessage(error)}`),
      )
    publish(this.session.sessionId, { t: 'inject', v: message })
    return true
  }

  isRunning(): boolean {
    return this.session.isRunning()
  }

  setThinking(level: ThinkingConfig['level'] | undefined): void {
    this.session.setThinking(level)
  }

  getThinking(): { level: ThinkingConfig['level']; source: 'session' | 'config' } {
    return this.session.getThinking()
  }

  getContext(): AgentContext {
    return this.session.getContext()
  }

  contextStatus(): Promise<ContextStatus> {
    return this.session.contextStatus()
  }

  clearContext(): void {
    this.sessions.delete(this.session.sessionId)
    this.session.clear()
  }

  resetSession(): void {
    this.sessions.delete(this.session.sessionId)
    this.session.reset()
  }

  /** One user turn; a thread id with no rollout behind it is dropped and the turn starts over. */
  private async drive(turn: HarnessTurn): Promise<HarnessOutcome> {
    const sessionId = this.session.sessionId
    const first = await this.attempt(turn, this.sessions.get(sessionId))
    if (!first.staleResume || turn.controller.signal.aborted) return first.outcome
    log.warn('operator', `Codex thread for ${sessionId} would not resume; starting a new one`)
    this.sessions.delete(sessionId)
    return (await this.attempt(turn, undefined)).outcome
  }

  private attempt(turn: HarnessTurn, resumeId: string | undefined) {
    const sessionId = this.session.sessionId
    const { options } = turn
    const context = this.session.getContext()
    return runCodexTurn({
      turn,
      connect: this.connect,
      cwd: context.workspaceDir,
      instructions: context.systemPrompt,
      model: this.config.operator?.model,
      resumeId,
      onThread: (threadId) => this.sessions.set(sessionId, threadId),
      onLive: (live) => {
        this.live = live
      },
      // app-server has no turn cap of its own: stop after this many tool calls, as the SDK's
      // maxTurns stops Claude. An unbounded run (a task) ends on its own.
      ...(!options.unbounded && {
        maxToolCalls: options.maxTurns ?? this.config.conversation.maxTurns ?? 10,
      }),
    })
  }
}
