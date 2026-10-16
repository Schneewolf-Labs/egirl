import { type Options as ClaudeAgentOptions, query } from '@anthropic-ai/claude-agent-sdk'
import { attachmentNote, saveImageAttachments } from '../agent/attachments'
import { runAutoExtraction } from '../agent/background'
import {
  type AgentContext,
  addMessage,
  createAgentContext,
  type SystemPromptOptions,
} from '../agent/context'
import { type AgentEventHandler, publishingEvents } from '../agent/events'
import { ConversationHistory } from '../agent/history'
import { RECALL_PREFIX } from '../agent/recall'
import { endRun, publish, startRun } from '../agent/session-events'
import type { SessionMutex } from '../agent/session-mutex'
import type { ContextStatus } from '../agent/status'
import type { AgentLoopOptions, AgentResponse } from '../agent/types'
import type { RuntimeConfig } from '../config'
import type { ConversationStore } from '../conversation'
import type { MemoryManager } from '../memory'
import { retrieveForContext } from '../memory/retrieval'
import type { LLMProvider, ThinkingConfig } from '../providers/types'
import { sanitizeContent } from '../safety/injection-scanner'
import type { Skill } from '../skills/types'
import type { ToolExecutor } from '../tools'
import type { ToolCallContext } from '../tools/types'
import { errorMessage } from '../util/errors'
import { log } from '../util/logger'
import {
  consumeQuery,
  type QueryOutcome,
  thinkingOptions,
  userTurnWithImages,
} from './claude-messages'
import type { ClaudeSessionMap } from './claude-sessions'
import { createEgirlMcpServer, MCP_SERVER_NAME } from './claude-tools'
import type { Operator } from './types'

/**
 * Claude as the operator: a Claude Code session, run through the Agent SDK on the user's own
 * subscription, whose only tools are egirl's.
 *
 * The SDK owns the loop, the transcript and the context window. egirl supplies what makes it
 * this instance rather than a stranger: the system prompt built from the workspace (SOUL.md,
 * IDENTITY.md, memory), the tool registry over an in-process MCP server, proactive recall on
 * each turn, memory extraction afterwards, and the session id that resumes the same
 * conversation after a restart. What the local loop does to keep a small model on the rails
 * (nudges, spiral and repetition guards, compaction, rollover) is deliberately not rebuilt
 * here: the harness has its own, and the model needs less.
 *
 * Not routing. An instance configured with `[operator] provider = "claude"` is a Claude
 * instance; it never falls back to the local model for a turn. The local model still does
 * the side work it always did (memory extraction, the supervisor, background tasks).
 */

export type QueryFn = typeof query

export interface ClaudeOperatorDeps {
  config: RuntimeConfig
  toolExecutor: ToolExecutor
  sessionId: string
  /** The local model: memory extraction after a turn still runs there. */
  localProvider: LLMProvider
  auxProvider?: LLMProvider
  memory?: MemoryManager
  conversationStore?: ConversationStore
  skills?: Skill[]
  additionalContext?: string
  sessionMutex?: SessionMutex
  sessions: ClaudeSessionMap
  /** The SDK entry point; tests hand in a fake. */
  queryFn?: QueryFn
}

/** The window the SDK reports against. An estimate for /context; the harness is the authority. */
const CLAUDE_CONTEXT_TOKENS = 200_000

export class ClaudeOperator implements Operator {
  private config: RuntimeConfig
  private executor: ToolExecutor
  private context: AgentContext
  private history: ConversationHistory
  private promptOptions: SystemPromptOptions
  private mutex: SessionMutex | null
  private memory: MemoryManager | null
  private sideProvider: LLMProvider
  private sessions: ClaudeSessionMap
  private queryFn: QueryFn
  private thinkingOverride: ThinkingConfig | undefined
  private activeRun: { controller: AbortController } | null = null
  private runChain: Promise<void> = Promise.resolve()
  private lastContextTokens = 0

  constructor(deps: ClaudeOperatorDeps) {
    this.config = deps.config
    this.executor = deps.toolExecutor
    this.mutex = deps.sessionMutex ?? null
    this.memory = deps.memory ?? null
    this.sideProvider = deps.auxProvider ?? deps.localProvider
    this.sessions = deps.sessions
    this.queryFn = deps.queryFn ?? query
    this.promptOptions = { skills: deps.skills, additionalContext: deps.additionalContext }
    this.context = createAgentContext(deps.config, deps.sessionId, this.promptOptions)
    this.history = new ConversationHistory(deps.conversationStore ?? null, deps.sessionId)
    this.history.hydrate(this.context)
  }

  interrupt(): boolean {
    if (!this.activeRun) return false
    this.activeRun.controller.abort('interrupt')
    return true
  }

  /** The SDK takes one prompt per turn; there is no running turn to slip a message into. */
  inject(_message: string): boolean {
    return false
  }

  isRunning(): boolean {
    return this.activeRun !== null
  }

  setThinking(level: ThinkingConfig['level'] | undefined): void {
    this.thinkingOverride = level === undefined ? undefined : { level }
  }

  getThinking(): { level: ThinkingConfig['level']; source: 'session' | 'config' } {
    if (this.thinkingOverride) return { level: this.thinkingOverride.level, source: 'session' }
    return { level: this.config.thinking.level, source: 'config' }
  }

  getContext(): AgentContext {
    return this.context
  }

  async contextStatus(): Promise<ContextStatus> {
    const systemPromptTokens = Math.ceil(this.context.systemPrompt.length / 4)
    const totalUsed = Math.max(this.lastContextTokens, systemPromptTokens)
    return {
      contextLength: CLAUDE_CONTEXT_TOKENS,
      systemPromptTokens,
      messageCount: this.context.messages.length,
      messageTokens: Math.max(0, totalUsed - systemPromptTokens),
      summaryTokens: 0,
      totalUsed,
      available: CLAUDE_CONTEXT_TOKENS - totalUsed,
      utilization: totalUsed / CLAUDE_CONTEXT_TOKENS,
      hasSummary: false,
      sessionId: this.context.sessionId,
    }
  }

  clearContext(): void {
    this.sessions.delete(this.context.sessionId)
    this.context = createAgentContext(this.config, this.context.sessionId, this.promptOptions)
    this.history.reset()
    this.lastContextTokens = 0
  }

  resetSession(): void {
    this.history.deleteStored()
    this.clearContext()
  }

  /** Runs on one session are serialized, as on the local loop. */
  async run(userMessage: string, options: AgentLoopOptions = {}): Promise<AgentResponse> {
    const previous = this.runChain
    let release = () => {}
    this.runChain = new Promise((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await this.runAdmitted(userMessage, options)
    } finally {
      release()
    }
  }

  private async runAdmitted(
    userMessage: string,
    options: AgentLoopOptions,
  ): Promise<AgentResponse> {
    const sessionId = this.context.sessionId
    const events = publishingEvents(sessionId, options.events)
    const controller = new AbortController()
    const external = options.signal
    const forwardAbort = () => controller.abort(external?.reason ?? 'external')
    if (external) {
      if (external.aborted) forwardAbort()
      else external.addEventListener('abort', forwardAbort, { once: true })
    }
    this.activeRun = { controller }
    startRun(sessionId, this, userMessage)
    const startedAt = Date.now()

    const toolCtx: ToolCallContext = { sessionId }
    let text = userMessage
    if (options.images?.length) {
      const saved = saveImageAttachments(this.context.workspaceDir, sessionId, options.images)
      toolCtx.images = saved.map((s) => s.path)
      const note = attachmentNote(saved)
      if (note) text = `${text}\n\n${note}`
    }
    addMessage(this.context, { role: 'user', content: text })
    const body = await this.withRecall(userMessage, text)

    try {
      let outcome = await this.runQuery(body, options, events, controller, toolCtx)
      // A resume id that no longer has a transcript behind it (a cleaned ~/.claude, another
      // machine) fails before anything runs. Start over once rather than stay stuck on it.
      if (outcome.error && !outcome.sawAssistant && this.sessions.get(sessionId)) {
        log.warn('operator', `Claude session for ${sessionId} would not resume; starting fresh`)
        this.sessions.delete(sessionId)
        outcome = await this.runQuery(body, options, events, controller, toolCtx)
      }
      if (outcome.error && !controller.signal.aborted) throw new Error(outcome.error)

      const aborted = controller.signal.aborted
      addMessage(this.context, { role: 'assistant', content: outcome.content })
      this.history.persistNew(this.context.messages)
      this.lastContextTokens = outcome.contextTokens || this.lastContextTokens
      events.onResponseComplete?.()
      this.maybeRunAutoExtraction()
      endRun(sessionId, {
        t: 'run_end',
        v: {
          content: outcome.content,
          input_tokens: outcome.usage.input_tokens,
          output_tokens: outcome.usage.output_tokens,
          turns: outcome.turns,
          duration_ms: Date.now() - startedAt,
          aborted,
          awaiting: false,
        },
      })
      return {
        content: outcome.content,
        provider: 'claude',
        usage: outcome.usage,
        turns: outcome.turns,
        ...(outcome.thinking && { thinking: outcome.thinking }),
        ...(aborted && { aborted: true }),
      }
    } catch (error) {
      endRun(sessionId, { t: 'error', v: errorMessage(error) })
      throw error
    } finally {
      external?.removeEventListener('abort', forwardAbort)
      this.activeRun = null
    }
  }

  /** One SDK query: a single user turn against the resumed (or new) Claude session. */
  private async runQuery(
    body: string,
    options: AgentLoopOptions,
    events: AgentEventHandler,
    controller: AbortController,
    toolCtx: ToolCallContext,
  ): Promise<QueryOutcome> {
    const sessionId = this.context.sessionId
    const resumeId = this.sessions.get(sessionId)
    const mcp = createEgirlMcpServer({
      executor: this.executor,
      cwd: this.context.workspaceDir,
      ctx: toolCtx,
      exclusive: (fn) => (this.mutex ? this.mutex.run(fn) : fn()),
      onResult: (name, args, result) => {
        events.onToolCallComplete?.(name, name, result)
        publish(sessionId, {
          t: 'tool_done',
          v: { name, success: result.success, args: JSON.stringify(args), output: result.output },
        })
      },
    })
    const operator = this.config.operator
    const sdkOptions: ClaudeAgentOptions = {
      // A string replaces the Claude Code preset outright: this is the workspace's persona
      // and instructions, not a coding assistant's.
      systemPrompt: this.context.systemPrompt,
      // No built-ins. Every tool Claude sees is egirl's, through the one executor and its
      // safety layer, which is why the SDK's own permission gate is bypassed.
      tools: [],
      mcpServers: { [MCP_SERVER_NAME]: { type: 'sdk', name: MCP_SERVER_NAME, instance: mcp } },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      cwd: this.context.workspaceDir,
      maxTurns: options.maxTurns ?? this.config.conversation.maxTurns ?? 10,
      includePartialMessages: true,
      abortController: controller,
      ...(operator?.model && { model: operator.model }),
      ...thinkingOptions(this.getThinking().level),
      ...(resumeId ? { resume: resumeId } : { sessionId: crypto.randomUUID() }),
    }

    // Built per attempt: an input stream can be read once, and a stale resume retries.
    const prompt = options.images?.length ? userTurnWithImages(body, options.images) : body
    return consumeQuery(this.queryFn({ prompt, options: sdkOptions }), controller, events, (id) =>
      this.sessions.set(sessionId, id),
    )
  }

  /** The turn's text, prefixed with recalled memory when proactive retrieval is on. */
  private async withRecall(userMessage: string, text: string): Promise<string> {
    let body = text
    if (this.memory && this.config.memory.proactiveRetrieval) {
      const recalled = await retrieveForContext(userMessage, this.memory, {
        scoreThreshold: this.config.memory.scoreThreshold,
        maxResults: this.config.memory.maxResults,
        maxTokensBudget: this.config.memory.maxTokensBudget,
      })
      if (recalled) body = `${RECALL_PREFIX}\n${sanitizeContent(recalled)}\n\n${text}`
    }
    return body
  }

  private maybeRunAutoExtraction(): void {
    if (!this.memory || !this.config.memory.autoExtract) return
    const fresh = this.history.takeUnextracted(this.context.messages)
    if (fresh.length === 0) return
    runAutoExtraction({
      messages: fresh,
      provider: this.sideProvider,
      memory: this.memory,
      sessionId: this.context.sessionId,
      minMessages: this.config.memory.extractionMinMessages,
      maxExtractions: this.config.memory.extractionMaxPerTurn,
    })
  }
}
