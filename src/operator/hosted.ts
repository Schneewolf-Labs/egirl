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
import type { Drive, ServedTool } from './hosted-types'
import { createRunSignals, noteResult, type RunSignals, wrapupNote } from './run-signals'
import type { Operator } from './types'

/**
 * The half of a hosted operator that is egirl's, whatever harness runs the model.
 *
 * A hosted harness (Claude Code, Codex) owns the loop, the transcript and the context window.
 * What makes the session this instance's rather than a stranger's is the same for every
 * harness: the system prompt built from the workspace, recall before a turn and extraction
 * after it, the conversation mirror the console reads, one run at a time per session, the
 * session bus, and every tool call served through the one executor with its run signals.
 * That lives here once; a harness supplies only `drive`, which runs one user turn.
 */

export interface HostedSessionDeps {
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
}

interface ServeScope {
  toolCtx: ToolCallContext
  options: AgentLoopOptions
  events: AgentEventHandler
  signals: RunSignals
  controller: AbortController
}

export class HostedSession {
  private config: RuntimeConfig
  private executor: ToolExecutor
  private context: AgentContext
  private history: ConversationHistory
  private promptOptions: SystemPromptOptions
  private mutex: SessionMutex | null
  private memory: MemoryManager | null
  private sideProvider: LLMProvider
  private thinkingOverride: ThinkingConfig | undefined
  private activeRun: { controller: AbortController } | null = null
  private runChain: Promise<void> = Promise.resolve()
  private lastContextTokens = 0
  private nextCall = 0

  constructor(
    deps: HostedSessionDeps,
    /** The operator this session belongs to: what the bus hands to interrupt and inject. */
    private owner: Operator,
    /** `provider` on the response; the harness's name. */
    private provider: string,
    /** The window /context measures against until the harness reports its own. */
    private contextWindow: number,
  ) {
    this.config = deps.config
    this.executor = deps.toolExecutor
    this.mutex = deps.sessionMutex ?? null
    this.memory = deps.memory ?? null
    this.sideProvider = deps.auxProvider ?? deps.localProvider
    this.promptOptions = { skills: deps.skills, additionalContext: deps.additionalContext }
    this.context = createAgentContext(deps.config, deps.sessionId, this.promptOptions)
    this.history = new ConversationHistory(deps.conversationStore ?? null, deps.sessionId)
    this.history.hydrate(this.context)
  }

  get sessionId(): string {
    return this.context.sessionId
  }

  interrupt(): boolean {
    if (!this.activeRun) return false
    this.activeRun.controller.abort('interrupt')
    return true
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
    const window = this.contextWindow
    return {
      contextLength: window,
      systemPromptTokens,
      messageCount: this.context.messages.length,
      messageTokens: Math.max(0, totalUsed - systemPromptTokens),
      summaryTokens: 0,
      totalUsed,
      available: window - totalUsed,
      utilization: totalUsed / window,
      hasSummary: false,
      sessionId: this.context.sessionId,
    }
  }

  /** Forget the live conversation; the operator forgets its harness session alongside. */
  clear(): void {
    this.context = createAgentContext(this.config, this.context.sessionId, this.promptOptions)
    this.history.reset()
    this.lastContextTokens = 0
  }

  reset(): void {
    this.history.deleteStored()
    this.clear()
  }

  /** Runs on one session are serialized, as on the local loop. */
  async run(userMessage: string, options: AgentLoopOptions, drive: Drive): Promise<AgentResponse> {
    const previous = this.runChain
    let release = () => {}
    this.runChain = new Promise((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await this.runAdmitted(userMessage, options, drive)
    } finally {
      release()
    }
  }

  private async runAdmitted(
    userMessage: string,
    options: AgentLoopOptions,
    drive: Drive,
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
    startRun(sessionId, this.owner, userMessage)
    const startedAt = Date.now()
    const signals = createRunSignals()
    let persisted = false

    try {
      const toolCtx: ToolCallContext = { sessionId }
      let text = userMessage
      let imagePaths: string[] | undefined
      if (options.images?.length) {
        const saved = saveImageAttachments(this.context.workspaceDir, sessionId, options.images)
        imagePaths = saved.map((s) => s.path)
        toolCtx.images = imagePaths
        const note = attachmentNote(saved)
        if (note) text = `${text}\n\n${note}`
      }
      addMessage(this.context, { role: 'user', content: text })
      const extra = [...(options.extraTools?.values() ?? [])].map((t) => t.definition)
      const scope: ServeScope = { toolCtx, options, events, signals, controller }
      const outcome = await drive({
        body: await this.withRecall(userMessage, text),
        ...(options.images?.length && { images: options.images, imagePaths }),
        options,
        events,
        controller,
        thinking: this.getThinking().level,
        tools: [...this.executor.getDefinitions(), ...extra],
        callTool: (name, args) => this.serve(name, args, scope),
      })
      if (outcome.error && !outcome.turnLimitReached && !controller.signal.aborted) {
        throw new Error(outcome.error)
      }

      // end_task stops the harness by aborting it; that is the run ending, not being cancelled.
      const aborted = controller.signal.aborted && signals.ended === undefined
      // Out of turns: what the model last said stands, as the local loop's forced reply does.
      const content =
        signals.ended ??
        (outcome.content ||
          (outcome.turnLimitReached
            ? `(Stopped at the ${outcome.turns}-turn limit before writing a reply.)`
            : ''))
      addMessage(this.context, { role: 'assistant', content })
      this.history.persistNew(this.context.messages)
      persisted = true
      this.lastContextTokens = outcome.contextTokens || this.lastContextTokens
      if (outcome.contextWindow) this.contextWindow = outcome.contextWindow
      events.onResponseComplete?.()
      this.maybeRunAutoExtraction()
      endRun(sessionId, {
        t: 'run_end',
        v: {
          content,
          input_tokens: outcome.usage.input_tokens,
          output_tokens: outcome.usage.output_tokens,
          turns: outcome.turns,
          duration_ms: Date.now() - startedAt,
          aborted,
          awaiting: signals.awaitingInput,
        },
      })
      return {
        content,
        provider: this.provider,
        usage: outcome.usage,
        turns: outcome.turns,
        ...(outcome.thinking && { thinking: outcome.thinking }),
        ...(aborted && { aborted: true }),
        ...(signals.awaitingInput && { awaitingInput: true }),
        ...(outcome.turnLimitReached && { turnLimitReached: true }),
      }
    } catch (error) {
      endRun(sessionId, { t: 'error', v: errorMessage(error) })
      throw error
    } finally {
      // A failed turn's user message is kept, as on the local loop.
      if (!persisted) this.history.persistNew(this.context.messages)
      external?.removeEventListener('abort', forwardAbort)
      this.activeRun = null
    }
  }

  /**
   * One tool call the harness asked for. The run's own tools run inline, never through the
   * shared executor, as the local loop runs them; everything else goes through the executor
   * and its safety layer, under the shared-state lock.
   */
  private async serve(
    name: string,
    args: Record<string, unknown>,
    scope: ServeScope,
  ): Promise<ServedTool> {
    const cwd = this.context.workspaceDir
    const extra = scope.options.extraTools?.get(name)
    const call = () =>
      this.executor.execute(
        { id: `call_${this.nextCall++}`, name, arguments: args },
        cwd,
        scope.toolCtx,
      )
    const result = extra
      ? await extra.execute(args, cwd, scope.toolCtx)
      : await (this.mutex ? this.mutex.run(call) : call())
    scope.events.onToolCallComplete?.(name, name, result)
    publish(this.context.sessionId, {
      t: 'tool_done',
      v: { name, success: result.success, args: JSON.stringify(args), output: result.output },
    })
    // No further turns after end_task: stop the harness once this result is on its way back.
    if (noteResult(scope.signals, result)) setTimeout(() => scope.controller.abort('end_task'), 0)
    return { result, note: wrapupNote(scope.signals, scope.options) }
  }

  /** The turn's text, prefixed with recalled memory when proactive retrieval is on. */
  private async withRecall(userMessage: string, text: string): Promise<string> {
    if (!this.memory || !this.config.memory.proactiveRetrieval) return text
    const recalled = await retrieveForContext(userMessage, this.memory, {
      scoreThreshold: this.config.memory.scoreThreshold,
      maxResults: this.config.memory.maxResults,
      maxTokensBudget: this.config.memory.maxTokensBudget,
    })
    return recalled ? `${RECALL_PREFIX}\n${sanitizeContent(recalled)}\n\n${text}` : text
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
