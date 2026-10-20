import { type Options as ClaudeAgentOptions, query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentContext } from '../agent/context'
import type { ContextStatus } from '../agent/status'
import type { AgentLoopOptions, AgentResponse } from '../agent/types'
import type { RuntimeConfig } from '../config'
import type { ThinkingConfig } from '../providers/types'
import { log } from '../util/logger'
import { consumeQuery, thinkingOptions, userTurnWithImages } from './claude-messages'
import { createEgirlMcpServer, MCP_SERVER_NAME } from './claude-tools'
import { HostedSession, type HostedSessionDeps } from './hosted'
import type { HarnessOutcome, HarnessTurn } from './hosted-types'
import type { SessionMap } from './session-map'
import type { Operator } from './types'

/**
 * Claude as the operator: a Claude Code session, run through the Agent SDK on the user's own
 * subscription, whose only tools are egirl's.
 *
 * The SDK owns the loop, the transcript and the context window. The hosted session (./hosted)
 * supplies what makes it this instance rather than a stranger; this file is only the Claude
 * half: the SDK options, the in-process MCP server, and resuming the Claude session that
 * continues this egirl session. What the local loop does to keep a small model on the rails
 * (nudges, spiral and repetition guards, compaction, rollover) is deliberately not rebuilt
 * here: the harness has its own, and the model needs less.
 *
 * Not routing. An instance configured with `[operator] provider = "claude"` is a Claude
 * instance; it never falls back to the local model for a turn, and its background tasks run
 * here too. The local model still does the side work it always did (memory extraction, the
 * permission supervisor, a task's self-review).
 */

export type QueryFn = typeof query

export interface ClaudeOperatorDeps extends HostedSessionDeps {
  sessions: SessionMap
  /**
   * Start a new Claude session rather than resume the stored one: a task run that begins
   * clean, as the local loop does when the runner hands it no transcript.
   */
  isFresh?: boolean
  /** The SDK entry point; tests hand in a fake. */
  queryFn?: QueryFn
}

/** The window the SDK reports against. An estimate for /context; the harness is the authority. */
const CLAUDE_CONTEXT_TOKENS = 200_000
/** What the CLI says when asked to resume a session it has no transcript for. */
const STALE_RESUME = 'No conversation found with session ID'

export class ClaudeOperator implements Operator {
  private session: HostedSession
  private config: RuntimeConfig
  private sessions: SessionMap
  private queryFn: QueryFn

  constructor(deps: ClaudeOperatorDeps) {
    this.config = deps.config
    this.sessions = deps.sessions
    this.queryFn = deps.queryFn ?? query
    this.session = new HostedSession(deps, this, 'claude', CLAUDE_CONTEXT_TOKENS)
    if (deps.isFresh) this.sessions.delete(deps.sessionId)
  }

  run(message: string, options: AgentLoopOptions = {}): Promise<AgentResponse> {
    return this.session.run(message, options, (turn) => this.drive(turn))
  }

  interrupt(): boolean {
    return this.session.interrupt()
  }

  /** The SDK takes one prompt per turn; there is no running turn to slip a message into. */
  inject(_message: string): boolean {
    return false
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

  /**
   * One user turn. A resume id with no transcript behind it (a cleaned ~/.claude, another
   * machine) fails before anything runs: start over once rather than stay stuck on it. Only that
   * error: dropping the id on a network or login failure would lose the conversation for good.
   */
  private async drive(turn: HarnessTurn): Promise<HarnessOutcome> {
    const sessionId = this.session.sessionId
    const outcome = await this.query(turn)
    if (
      !outcome.error?.includes(STALE_RESUME) ||
      outcome.sawAssistant ||
      turn.controller.signal.aborted ||
      !this.sessions.get(sessionId)
    ) {
      return outcome
    }
    log.warn('operator', `Claude session for ${sessionId} would not resume; starting fresh`)
    this.sessions.delete(sessionId)
    return this.query(turn)
  }

  /** One SDK query: a single user turn against the resumed (or new) Claude session. */
  private query(turn: HarnessTurn): Promise<HarnessOutcome> {
    const sessionId = this.session.sessionId
    const resumeId = this.sessions.get(sessionId)
    const { options } = turn
    const sdkOptions: ClaudeAgentOptions = {
      // A string replaces the Claude Code preset outright: this is the workspace's persona
      // and instructions, not a coding assistant's.
      systemPrompt: this.session.getContext().systemPrompt,
      // No built-ins. Every tool Claude sees is egirl's, through the one executor and its
      // safety layer, which is why the SDK's own permission gate is bypassed.
      tools: [],
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'sdk',
          name: MCP_SERVER_NAME,
          instance: createEgirlMcpServer(turn.tools, turn.callTool),
        },
      },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      cwd: this.session.getContext().workspaceDir,
      // An unbounded run (a task) ends on its own; the harness's guards stand in for the cap.
      ...(!options.unbounded && {
        maxTurns: options.maxTurns ?? this.config.conversation.maxTurns ?? 10,
      }),
      includePartialMessages: true,
      abortController: turn.controller,
      ...(this.config.operator?.model && { model: this.config.operator.model }),
      ...thinkingOptions(turn.thinking),
      ...(resumeId ? { resume: resumeId } : { sessionId: crypto.randomUUID() }),
    }

    // Built per attempt: an input stream can be read once, and a stale resume retries.
    const prompt = turn.images?.length ? userTurnWithImages(turn.body, turn.images) : turn.body
    return consumeQuery(
      this.queryFn({ prompt, options: sdkOptions }),
      turn.controller,
      turn.events,
      (id) => this.sessions.set(sessionId, id),
    )
  }
}
