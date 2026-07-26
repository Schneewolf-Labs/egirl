import type { RuntimeConfig } from '../config'
import type { ConversationStore } from '../conversation'
import type { MemoryManager } from '../memory'
import { createLlamaCppTokenizer } from '../providers/llamacpp-tokenizer'
import type {
  ChatMessage,
  ChatResponse,
  LLMProvider,
  ThinkingConfig,
  Tokenizer,
} from '../providers/types'
import type { ToolExecutor } from '../tools'
import type { TranscriptLogger } from '../tracking/transcript'
import { log } from '../util/logger'
import { runAutoExtraction } from './background'
import { chatWithContextWindow } from './chat'
import { CompactionScheduler } from './compaction'
import {
  type AgentContext,
  addMessage,
  createAgentContext,
  type SystemPromptOptions,
} from './context'
import type { AgentEventHandler } from './events'
import { ConversationHistory } from './history'
import { injectRecalledMemory } from './recall'
import type { SessionMutex } from './session-mutex'
import { type ContextStatus, computeContextStatus } from './status'
import { reportTokenBudget, TokenBudgetTracker } from './token-budget'
import { runToolCalls } from './tool-runner'
import type { AgentLoopDeps, AgentLoopOptions, AgentResponse } from './types'

/** Maximum number of continuation retries when response is truncated (finish_reason: length) */
const MAX_CONTINUATION_RETRIES = 3

export type AgentFactory = (sessionId: string) => AgentLoop

export class AgentLoop {
  private config: RuntimeConfig
  private toolExecutor: ToolExecutor
  private localProvider: LLMProvider
  private memory: MemoryManager | null
  private context: AgentContext
  private tokenizer: Tokenizer
  private conversationStore: ConversationStore | null
  private transcript: TranscriptLogger | null
  private promptOptions: SystemPromptOptions
  private mutex: SessionMutex | null
  private history: ConversationHistory
  private compactor = new CompactionScheduler()

  constructor(deps: AgentLoopDeps) {
    this.config = deps.config
    this.toolExecutor = deps.toolExecutor
    this.localProvider = deps.localProvider
    this.memory = deps.memory ?? null
    this.conversationStore = deps.conversationStore ?? null
    this.mutex = deps.sessionMutex ?? null
    this.transcript = deps.transcript ?? null
    this.promptOptions = { skills: deps.skills, additionalContext: deps.additionalContext }
    this.context = createAgentContext(deps.config, deps.sessionId, this.promptOptions)
    this.tokenizer = createLlamaCppTokenizer(deps.config.local.endpoint)
    this.history = new ConversationHistory(this.conversationStore, deps.sessionId)
    this.history.hydrate(this.context)
  }

  /**
   * Stable KV cache slot for this session. Local servers with per-slot prefix caching
   * (sabrewing) reuse the context this conversation already prefilled, which is the
   * difference between ~60 s and <1 s to first token on a continuation turn. The mapping
   * must be stable for the life of the session; collisions only cost a re-prefill, never
   * correctness, because the server matches on token content.
   */
  private cacheSlot(): number | undefined {
    const slots = this.config.local.cacheSlots
    if (!slots || slots < 1) return undefined
    const id = this.context.sessionId
    let h = 2166136261
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return Math.abs(h) % slots
  }

  async run(userMessage: string, options: AgentLoopOptions = {}): Promise<AgentResponse> {
    // The mutex guards tool execution only (see SessionMutex): inference runs outside it
    // so concurrent sessions can be batched by the local server. Wrapping the whole run
    // here would serialize every entry point again.
    return this.doRun(userMessage, options)
  }

  /** Run a tool phase under the shared-state lock. */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutex ? this.mutex.run(fn) : fn()
  }

  private async doRun(userMessage: string, options: AgentLoopOptions): Promise<AgentResponse> {
    await this.compactor.drain()

    const { maxTurns = 10, events, planningMode, signal } = options
    const turnStartedAt = Date.now()

    const thinking: ThinkingConfig | undefined =
      options.thinking ??
      (this.config.thinking.level !== 'off'
        ? { level: this.config.thinking.level, budgetTokens: this.config.thinking.budgetTokens }
        : undefined)

    const userContent = planningMode
      ? `[PLANNING MODE] Create a detailed step-by-step plan for the following request. Do NOT execute any tools yet — only output a numbered plan with clear steps. After the plan is approved, you will execute it.\n\n${userMessage}`
      : userMessage

    this.transcript?.turnStart(this.context.sessionId, userMessage)
    addMessage(this.context, { role: 'user', content: userContent })

    await injectRecalledMemory({
      userMessage,
      context: this.context,
      memory: this.memory,
      config: this.config,
      history: this.history,
      transcript: this.transcript,
    })

    let turns = 0
    const totalUsage = { input_tokens: 0, output_tokens: 0 }
    let finalContent = ''
    const provider = this.localProvider

    const budgetTracker = new TokenBudgetTracker(this.config.local.contextLength)

    let lastThinking: string | undefined
    let isPlanning = !!planningMode
    const seenToolCalls = new Set<string>()
    let continuationRetries = 0
    let accumulatedContent = ''
    let validationRetried = false

    // Persistence and transcript closure run in `finally` so a provider error
    // mid-run doesn't lose the user message and tool activity already in context.
    try {
      while (turns < maxTurns) {
        if (signal?.aborted) {
          log.info('agent', 'Agent run aborted by signal')
          break
        }

        turns++

        const tools = isPlanning ? [] : this.toolExecutor.getDefinitions()

        let response: ChatResponse
        const inferenceStart = Date.now()
        try {
          const result = await chatWithContextWindow({
            provider,
            systemPrompt: this.context.systemPrompt,
            messages: this.context.messages,
            conversationSummary: this.context.conversationSummary,
            tools,
            contextLength: this.config.local.contextLength,
            tokenizer: this.tokenizer,
            onToken: events?.onToken,
            thinking,
            signal,
            cacheSlot: this.cacheSlot(),
          })
          response = result.response

          if (result.wasTrimmed && this.config.conversation.contextCompaction) {
            this.scheduleCompaction(result.droppedMessages)
          }
        } catch (error) {
          if (signal?.aborted) {
            log.info('agent', 'Agent run aborted during inference')
            break
          }
          const err = error instanceof Error ? error : new Error(String(error))
          events?.onError?.(err)
          throw error
        }
        const inferenceDuration = Date.now() - inferenceStart

        totalUsage.input_tokens += response.usage.input_tokens
        totalUsage.output_tokens += response.usage.output_tokens

        this.transcript?.inference(this.context.sessionId, {
          provider: provider.name,
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          duration_ms: inferenceDuration,
          has_tool_calls: (response.tool_calls?.length ?? 0) > 0,
        })

        reportTokenBudget({
          tracker: budgetTracker,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          context: this.context,
          transcript: this.transcript,
          events,
        })

        if (response.thinking) {
          lastThinking = response.thinking
          events?.onThinking?.(response.thinking)
        }

        if (response.tool_calls && response.tool_calls.length > 0) {
          await this.exclusive(() =>
            runToolCalls({
              response,
              context: this.context,
              executor: this.toolExecutor,
              seenToolCalls,
              transcript: this.transcript,
              events,
              signal,
            }),
          )

          if (signal?.aborted) {
            log.info('agent', 'Agent run aborted after tool execution')
            break
          }
          continue
        }

        // No tool calls — check if response was truncated and needs continuation
        if (
          response.finish_reason === 'length' &&
          continuationRetries < MAX_CONTINUATION_RETRIES &&
          response.content.length > 0
        ) {
          continuationRetries++
          accumulatedContent += response.content
          log.info(
            'agent',
            `Response truncated (finish_reason: length), continuation retry ${continuationRetries}/${MAX_CONTINUATION_RETRIES}`,
          )

          addMessage(this.context, { role: 'assistant', content: response.content })
          addMessage(this.context, {
            role: 'user',
            content:
              '[System: Your previous response was cut off. Continue exactly where you left off.]',
          })
          continue
        }

        finalContent = accumulatedContent + response.content
        addMessage(this.context, { role: 'assistant', content: response.content })

        if (events?.onPostResponseValidation && !validationRetried) {
          const validation = await events.onPostResponseValidation(finalContent)
          if (!validation.valid) {
            validationRetried = true
            const feedback =
              validation.feedback ??
              'Your previous response did not pass validation. Please try again.'
            log.info('agent', `Post-response validation failed: ${feedback.slice(0, 100)}`)
            addMessage(this.context, { role: 'user', content: `[Validation failed]: ${feedback}` })
            accumulatedContent = ''
            continuationRetries = 0
            continue
          }
        }

        events?.onResponseComplete?.()

        if (isPlanning) {
          isPlanning = false
          return {
            content: finalContent,
            provider: provider.name,
            usage: totalUsage,
            turns,
            isPlan: true,
            thinking: lastThinking,
          }
        }

        break
      }

      if (turns >= maxTurns && !finalContent && !signal?.aborted) {
        log.warn('agent', `Exhausted max turns (${maxTurns}) without a final response`)
        finalContent = await this.forceFinalResponse(totalUsage, thinking, events, signal)
        events?.onResponseComplete?.()
      }

      this.maybeRunAutoExtraction()

      return {
        content: finalContent,
        provider: provider.name,
        usage: totalUsage,
        turns,
        thinking: lastThinking,
        continuationRetries: continuationRetries > 0 ? continuationRetries : undefined,
        aborted: signal?.aborted ? true : undefined,
      }
    } finally {
      this.history.persistNew(this.context.messages)
      this.transcript?.turnEnd(this.context.sessionId, {
        content_length: finalContent.length,
        provider: provider.name,
        input_tokens: totalUsage.input_tokens,
        output_tokens: totalUsage.output_tokens,
        turns,
        duration_ms: Date.now() - turnStartedAt,
      })
    }
  }

  /**
   * Force a final text response after max turns are exhausted mid-tool-flow.
   * Runs one extra inference with no tools so the model summarizes where it
   * got to, instead of returning a stale assistant message from history.
   */
  private async forceFinalResponse(
    totalUsage: { input_tokens: number; output_tokens: number },
    thinking?: ThinkingConfig,
    events?: AgentEventHandler,
    signal?: AbortSignal,
  ): Promise<string> {
    addMessage(this.context, {
      role: 'user',
      content:
        '[System: Maximum turns reached. Do not call any tools. Summarize what you accomplished, what remains unfinished, and your best answer so far.]',
    })

    try {
      const result = await chatWithContextWindow({
        provider: this.localProvider,
        systemPrompt: this.context.systemPrompt,
        messages: this.context.messages,
        conversationSummary: this.context.conversationSummary,
        tools: [],
        contextLength: this.config.local.contextLength,
        tokenizer: this.tokenizer,
        cacheSlot: this.cacheSlot(),
        onToken: events?.onToken,
        thinking,
        signal,
      })

      totalUsage.input_tokens += result.response.usage.input_tokens
      totalUsage.output_tokens += result.response.usage.output_tokens

      const content = result.response.content.trim()
      if (content) {
        addMessage(this.context, { role: 'assistant', content: result.response.content })
        return result.response.content
      }
    } catch (error) {
      log.warn('agent', 'Forced final response failed:', error)
    }

    return '[Agent reached maximum turns without producing a final response]'
  }

  private scheduleCompaction(droppedMessages: ChatMessage[]): void {
    this.compactor.schedule({
      droppedMessages,
      context: this.context,
      history: this.history,
      provider: this.localProvider,
      memory: this.memory,
      conversationStore: this.conversationStore,
    })
  }

  private maybeRunAutoExtraction(): void {
    if (!this.memory || !this.config.memory.autoExtract) return

    const newMessages = this.history.takeUnextracted(this.context.messages)
    if (newMessages.length === 0) return

    runAutoExtraction({
      messages: newMessages,
      provider: this.localProvider,
      memory: this.memory,
      sessionId: this.context.sessionId,
      minMessages: this.config.memory.extractionMinMessages,
      maxExtractions: this.config.memory.extractionMaxPerTurn,
    })
  }

  getContext(): AgentContext {
    return this.context
  }

  /** Get a snapshot of the current context window usage */
  contextStatus(): Promise<ContextStatus> {
    return computeContextStatus(this.config, this.tokenizer, this.context)
  }

  /** Manually trigger context compaction on the current conversation */
  async compactNow(): Promise<{ messagesBefore: number; messagesAfter: number }> {
    await this.compactor.drain()

    const messagesBefore = this.context.messages.length
    if (messagesBefore < 4) {
      return { messagesBefore, messagesAfter: messagesBefore }
    }

    const keepCount = 4
    const dropCount = messagesBefore - keepCount
    const droppedMessages = this.context.messages.slice(0, dropCount)
    const keptMessages = this.context.messages.slice(dropCount)

    this.scheduleCompaction(droppedMessages)

    this.context.messages = keptMessages
    this.history.replaceAll(keptMessages)

    return { messagesBefore, messagesAfter: keptMessages.length }
  }

  clearContext(): void {
    this.context = createAgentContext(this.config, this.context.sessionId, this.promptOptions)
    this.history.reset()
    this.compactor.reset()
  }

  resetSession(): void {
    this.history.deleteStored()
    this.clearContext()
  }
}

export function createAgentLoop(deps: AgentLoopDeps): AgentLoop {
  return new AgentLoop({
    ...deps,
    sessionId: deps.sessionId ?? crypto.randomUUID(),
  })
}
