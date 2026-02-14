import type { ChatMessage, ChatResponse, LLMProvider, ToolCall, ToolDefinition, Tokenizer } from '../providers/types'
import { ContextSizeError } from '../providers/types'
import type { RuntimeConfig } from '../config'
import type { ToolExecutor, ToolResult } from '../tools'
import type { Skill } from '../skills/types'
import type { AgentEventHandler } from './events'
import type { ConversationStore } from '../conversation'
import type { MemoryManager } from '../memory'
import { Router, shouldRetryWithRemote, analyzeResponseForEscalation } from '../routing'
import { createAgentContext, addMessage, type AgentContext, type SystemPromptOptions } from './context'
import { fitToContextWindow } from './context-window'
import { summarizeMessages, formatSummaryMessage } from './context-summarizer'
import { retrieveForContext } from '../memory/retrieval'
import { createLlamaCppTokenizer } from '../providers/llamacpp-tokenizer'
import { log } from '../util/logger'

/** Default context limits for remote providers */
const REMOTE_CONTEXT_LENGTH = 200_000

export interface AgentLoopOptions {
  maxTurns?: number
  events?: AgentEventHandler
}

export interface AgentResponse {
  content: string
  target: 'local' | 'remote'
  provider: string
  usage: {
    input_tokens: number
    output_tokens: number
  }
  escalated: boolean
  turns: number
}

export interface AgentLoopDeps {
  config: RuntimeConfig
  router: Router
  toolExecutor: ToolExecutor
  localProvider: LLMProvider
  remoteProvider: LLMProvider | null
  sessionId: string
  memory?: MemoryManager
  conversationStore?: ConversationStore
  skills?: Skill[]
}

export class AgentLoop {
  private config: RuntimeConfig
  private router: Router
  private toolExecutor: ToolExecutor
  private localProvider: LLMProvider
  private remoteProvider: LLMProvider | null
  private memory: MemoryManager | null
  private context: AgentContext
  private tokenizer: Tokenizer
  private conversationStore: ConversationStore | null
  private persistedIndex: number = 0
  private promptOptions: SystemPromptOptions

  constructor(deps: AgentLoopDeps) {
    this.config = deps.config
    this.router = deps.router
    this.toolExecutor = deps.toolExecutor
    this.localProvider = deps.localProvider
    this.remoteProvider = deps.remoteProvider
    this.memory = deps.memory ?? null
    this.conversationStore = deps.conversationStore ?? null
    this.promptOptions = { skills: deps.skills }
    this.context = createAgentContext(deps.config, deps.sessionId, this.promptOptions)
    this.tokenizer = createLlamaCppTokenizer(deps.config.local.endpoint)

    // Load conversation history and summary from store
    if (this.conversationStore) {
      const history = this.conversationStore.loadMessages(deps.sessionId)
      if (history.length > 0) {
        this.context.messages = history
        this.persistedIndex = history.length
        log.info('agent', `Loaded ${history.length} messages for session ${deps.sessionId}`)
      }

      const summary = this.conversationStore.loadSummary(deps.sessionId)
      if (summary) {
        this.context.conversationSummary = summary
        log.info('agent', `Loaded conversation summary (${summary.length} chars)`)
      }
    }
  }

  async run(userMessage: string, options: AgentLoopOptions = {}): Promise<AgentResponse> {
    const { maxTurns = 10, events } = options

    // Add user message to context
    addMessage(this.context, { role: 'user', content: userMessage })

    // Proactive memory retrieval — inject relevant memories before the LLM sees the message
    if (this.memory && this.config.memory.proactiveRetrieval) {
      const recalled = await retrieveForContext(userMessage, this.memory, {
        scoreThreshold: this.config.memory.scoreThreshold,
        maxResults: this.config.memory.maxResults,
        maxTokensBudget: this.config.memory.maxTokensBudget,
      })
      if (recalled) {
        addMessage(this.context, { role: 'system', content: recalled })
      }
    }

    // Route the request
    const routingDecision = this.router.route(this.context.messages, this.toolExecutor.listTools())
    events?.onRoutingDecision?.(routingDecision)

    let provider: LLMProvider = routingDecision.target === 'local' ? this.localProvider : (this.remoteProvider ?? this.localProvider)

    // Fallback to local if remote not available
    if (!this.remoteProvider && routingDecision.target === 'remote') {
      log.warn('agent', 'Remote provider not available, falling back to local')
      provider = this.localProvider
    }

    let turns = 0
    let escalated = false
    let totalUsage = { input_tokens: 0, output_tokens: 0 }
    let finalContent = ''
    let currentProvider = provider
    let currentTarget: 'local' | 'remote' = routingDecision.target

    while (turns < maxTurns) {
      turns++

      const tools = this.toolExecutor.getDefinitions()

      let response: ChatResponse
      try {
        response = await this.chatWithContextWindow(
          currentProvider,
          tools,
          currentTarget,
          events?.onToken
        )
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        events?.onError?.(err)
        throw error
      }

      totalUsage.input_tokens += response.usage.input_tokens
      totalUsage.output_tokens += response.usage.output_tokens

      // Check for escalation if we're using local
      if (currentTarget === 'local' && this.remoteProvider) {
        const escalationDecision = analyzeResponseForEscalation(response, this.config.routing.escalationThreshold)
        if (escalationDecision.shouldEscalate) {
          log.info('agent', `Escalating to remote model: ${escalationDecision.reason}`)
          events?.onEscalation?.(escalationDecision, currentProvider.name, this.remoteProvider.name)

          // Preserve the local response in context so the remote model has full history
          if (response.content) {
            addMessage(this.context, {
              role: 'assistant',
              content: `[Local model response (escalating due to ${escalationDecision.reason})]: ${response.content}`,
            })
          }

          currentProvider = this.remoteProvider
          currentTarget = 'remote'
          escalated = true
          continue
        }
      }

      // Handle tool calls
      if (response.tool_calls && response.tool_calls.length > 0) {
        addMessage(this.context, {
          role: 'assistant',
          content: response.content,
          tool_calls: response.tool_calls,
        })

        // Emit thinking text (content that came with tool calls)
        if (response.content && events?.onThinking) {
          events.onThinking(response.content)
        }

        // Emit tool call start event
        events?.onToolCallStart?.(response.tool_calls)

        const toolResults = await this.executeToolsWithHooks(response.tool_calls, events)

        for (const [callId, result] of toolResults) {
          log.debug('agent', `Tool ${callId}: ${result.output.substring(0, 100)}${result.output.length > 100 ? '...' : ''}`)

          const call = response.tool_calls.find(c => c.id === callId)
          events?.onToolCallComplete?.(callId, call?.name ?? 'unknown', result)

          addMessage(this.context, {
            role: 'tool',
            content: result.output,
            tool_call_id: callId,
          })

          if (result.suggest_escalation && currentTarget === 'local' && this.remoteProvider) {
            const escalationDecision = analyzeResponseForEscalation(response, this.config.routing.escalationThreshold)
            log.info('agent', `Tool suggests escalation: ${result.escalation_reason}`)
            events?.onEscalation?.(escalationDecision, currentProvider.name, this.remoteProvider.name)
            currentProvider = this.remoteProvider
            currentTarget = 'remote'
            escalated = true
          }
        }

        continue
      }

      // No tool calls, we have a final response
      finalContent = response.content
      addMessage(this.context, { role: 'assistant', content: finalContent })
      events?.onResponseComplete?.()
      break
    }

    // If we exhausted maxTurns without a final text response, recover what we can
    if (turns >= maxTurns && !finalContent) {
      log.warn('agent', `Exhausted max turns (${maxTurns}) without a final response`)

      // Find the last assistant message with content
      for (let i = this.context.messages.length - 1; i >= 0; i--) {
        const msg = this.context.messages[i]
        if (msg?.role === 'assistant' && msg.content && typeof msg.content === 'string' && msg.content.trim()) {
          finalContent = msg.content
          break
        }
      }

      if (!finalContent) {
        finalContent = '[Agent reached maximum turns without producing a final response]'
      }

      events?.onResponseComplete?.()
    }

    // Persist new messages from this run
    if (this.conversationStore) {
      try {
        const newMessages = this.context.messages.slice(this.persistedIndex)
        if (newMessages.length > 0) {
          this.conversationStore.appendMessages(this.context.sessionId, newMessages)
          this.persistedIndex = this.context.messages.length
        }
      } catch (error) {
        log.warn('agent', 'Failed to persist conversation:', error)
      }
    }

    return {
      content: finalContent,
      target: currentTarget,
      provider: currentProvider.name,
      usage: totalUsage,
      escalated,
      turns,
    }
  }

  /**
   * Send messages to a provider with context window management.
   * Uses the llama.cpp tokenizer for accurate token counting.
   * Retries once with the server's actual n_ctx if the count was still off.
   *
   * When messages are dropped to fit the context window, triggers
   * summarization of the dropped messages to preserve key context.
   */
  private async chatWithContextWindow(
    provider: LLMProvider,
    tools: ToolDefinition[],
    target: 'local' | 'remote',
    onToken?: (token: string) => void
  ): Promise<ChatResponse> {
    const contextLength = target === 'local'
      ? this.config.local.contextLength
      : REMOTE_CONTEXT_LENGTH

    // Use real tokenizer for local provider, skip for remote (no endpoint to call)
    const tokenizer = target === 'local' ? this.tokenizer : undefined

    // If we have a compacted summary, prepend it to the messages for fitting
    const messagesForFitting = this.context.conversationSummary
      ? [formatSummaryMessage(this.context.conversationSummary), ...this.context.messages]
      : this.context.messages

    const fitResult = await fitToContextWindow(
      this.context.systemPrompt,
      messagesForFitting,
      tools,
      { contextLength },
      tokenizer
    )

    // Trigger async summarization of dropped messages (if compaction enabled)
    if (fitResult.wasTrimmed && this.config.conversation.contextCompaction) {
      // Filter out the summary message itself from dropped messages — only summarize real conversation
      const droppedConversation = fitResult.droppedMessages.filter(
        m => !(m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('[Conversation summary'))
      )
      if (droppedConversation.length > 0) {
        this.triggerCompaction(droppedConversation)
      }
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: this.context.systemPrompt },
      ...fitResult.messages,
    ]

    log.debug('agent', `Sending ${messages.length} messages to ${provider.name} (budget: ${contextLength}t)`)

    try {
      return await this.chatWithRetry(provider, messages, tools, onToken)
    } catch (error) {
      if (!(error instanceof ContextSizeError)) throw error

      // Server reported a different context size than our config — retrim and retry once
      log.warn(
        'agent',
        `Server n_ctx=${error.contextSize} differs from config (${contextLength}). Retrimming.`
      )

      const refitResult = await fitToContextWindow(
        this.context.systemPrompt,
        messagesForFitting,
        tools,
        { contextLength: error.contextSize },
        tokenizer
      )

      const retryMessages: ChatMessage[] = [
        { role: 'system', content: this.context.systemPrompt },
        ...refitResult.messages,
      ]

      return await this.chatWithRetry(provider, retryMessages, tools, onToken)
    }
  }

  /**
   * Summarize dropped messages and update the conversation summary.
   * Runs asynchronously — the summary will be available on the next turn.
   * Uses the local provider to avoid API costs.
   */
  private triggerCompaction(droppedMessages: ChatMessage[]): void {
    const provider = this.localProvider
    const existingSummary = this.context.conversationSummary

    // Fire and forget — don't block the current response
    summarizeMessages(droppedMessages, provider, existingSummary)
      .then(summary => {
        this.context.conversationSummary = summary
        log.info('agent', `Context compacted: summary updated (${summary.length} chars)`)

        // Persist updated summary
        if (this.conversationStore) {
          try {
            this.conversationStore.updateSummary(this.context.sessionId, summary)
          } catch (error) {
            log.warn('agent', 'Failed to persist compacted summary:', error)
          }
        }
      })
      .catch(error => {
        log.warn('agent', 'Context compaction failed:', error)
      })
  }

  /**
   * Call provider.chat with retry on transient errors (network failures, 5xx).
   * Retries up to 2 times with exponential backoff (1s, 2s).
   */
  private async chatWithRetry(
    provider: LLMProvider,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken?: (token: string) => void,
    maxRetries = 2
  ): Promise<ChatResponse> {
    let lastError: unknown

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await provider.chat({ messages, tools, onToken })
      } catch (error) {
        lastError = error

        // Don't retry on ContextSizeError or other non-transient errors
        if (error instanceof ContextSizeError) throw error

        const isTransient = this.isTransientError(error)
        if (!isTransient || attempt >= maxRetries) throw error

        const delayMs = 1000 * (attempt + 1)
        log.warn('agent', `Provider error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`)
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }

    throw lastError
  }

  private isTransientError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    const msg = error.message.toLowerCase()
    // Network failures
    if (msg.includes('fetch failed') || msg.includes('econnrefused') ||
        msg.includes('econnreset') || msg.includes('etimedout') ||
        msg.includes('network') || msg.includes('socket')) {
      return true
    }
    // HTTP 5xx errors
    if (/\b5\d{2}\b/.test(msg)) return true
    // Rate limiting (429)
    if (msg.includes('429') || msg.includes('rate limit')) return true
    return false
  }

  private async executeTools(toolCalls: ToolCall[]): Promise<Map<string, ToolResult>> {
    return this.toolExecutor.executeAll(toolCalls, this.context.workspaceDir)
  }

  private async executeToolsWithHooks(
    toolCalls: ToolCall[],
    events?: AgentEventHandler
  ): Promise<Map<string, ToolResult>> {
    if (!events?.onBeforeToolExec && !events?.onAfterToolExec) {
      return this.executeTools(toolCalls)
    }

    // Run sequentially when hooks are present to avoid race conditions
    // (e.g., onBeforeToolExec prompting for user confirmation concurrently)
    const results = new Map<string, ToolResult>()

    for (const call of toolCalls) {
      // Pre-execution hook — skip if it returns false
      if (events?.onBeforeToolExec) {
        const shouldRun = await events.onBeforeToolExec(call)
        if (shouldRun === false) {
          const skipped: ToolResult = { success: false, output: `Tool ${call.name} skipped by hook` }
          events?.onAfterToolExec?.(call, skipped)
          results.set(call.id, skipped)
          continue
        }
      }

      const result = await this.toolExecutor.execute(call, this.context.workspaceDir)

      // Post-execution hook
      events?.onAfterToolExec?.(call, result)

      results.set(call.id, result)
    }

    return results
  }

  getContext(): AgentContext {
    return this.context
  }

  clearContext(): void {
    this.context = createAgentContext(this.config, this.context.sessionId, this.promptOptions)
    this.persistedIndex = 0
  }

  resetSession(): void {
    if (this.conversationStore) {
      this.conversationStore.deleteSession(this.context.sessionId)
    }
    this.clearContext()
  }
}

export type AgentFactory = (sessionId: string) => AgentLoop

export function createAgentLoop(deps: AgentLoopDeps): AgentLoop {
  return new AgentLoop({
    ...deps,
    sessionId: deps.sessionId ?? crypto.randomUUID(),
  })
}
