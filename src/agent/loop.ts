import type { ChatMessage, ChatResponse, LLMProvider, ToolCall, ToolDefinition, Tokenizer } from '../providers/types'
import { ContextSizeError } from '../providers/types'
import type { RuntimeConfig } from '../config'
import type { ToolExecutor, ToolResult } from '../tools'
import type { AgentEventHandler } from './events'
import { Router, shouldRetryWithRemote } from '../routing'
import { createAgentContext, addMessage, type AgentContext } from './context'
import { fitToContextWindow } from './context-window'
import { createLlamaCppTokenizer } from '../providers/llamacpp'
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

export class AgentLoop {
  private config: RuntimeConfig
  private router: Router
  private toolExecutor: ToolExecutor
  private localProvider: LLMProvider
  private remoteProvider: LLMProvider | null
  private context: AgentContext
  private tokenizer: Tokenizer

  constructor(
    config: RuntimeConfig,
    router: Router,
    toolExecutor: ToolExecutor,
    localProvider: LLMProvider,
    remoteProvider: LLMProvider | null,
    sessionId: string
  ) {
    this.config = config
    this.router = router
    this.toolExecutor = toolExecutor
    this.localProvider = localProvider
    this.remoteProvider = remoteProvider
    this.context = createAgentContext(config, sessionId)
    this.tokenizer = createLlamaCppTokenizer(config.local.endpoint)
  }

  async run(userMessage: string, options: AgentLoopOptions = {}): Promise<AgentResponse> {
    const { maxTurns = 10, events } = options

    // Add user message to context
    addMessage(this.context, { role: 'user', content: userMessage })

    // Route the request
    const routingDecision = this.router.route(this.context.messages, this.toolExecutor.listTools())

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
      const response = await this.chatWithContextWindow(
        currentProvider,
        tools,
        currentTarget,
        events?.onToken
      )

      totalUsage.input_tokens += response.usage.input_tokens
      totalUsage.output_tokens += response.usage.output_tokens

      // Check for escalation if we're using local
      if (currentTarget === 'local' && this.remoteProvider) {
        if (shouldRetryWithRemote(response, this.config.routing.escalationThreshold)) {
          log.info('agent', 'Escalating to remote model')
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

        const toolResults = await this.executeTools(response.tool_calls)

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
            log.info('agent', `Tool suggests escalation: ${result.escalation_reason}`)
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

    const fitted = await fitToContextWindow(
      this.context.systemPrompt,
      this.context.messages,
      tools,
      { contextLength },
      tokenizer
    )

    const messages: ChatMessage[] = [
      { role: 'system', content: this.context.systemPrompt },
      ...fitted,
    ]

    log.debug('agent', `Sending ${messages.length} messages to ${provider.name} (budget: ${contextLength}t)`)

    try {
      return await provider.chat({ messages, tools, onToken })
    } catch (error) {
      if (!(error instanceof ContextSizeError)) throw error

      // Server reported a different context size than our config — retrim and retry once
      log.warn(
        'agent',
        `Server n_ctx=${error.contextSize} differs from config (${contextLength}). Retrimming.`
      )

      const refitted = await fitToContextWindow(
        this.context.systemPrompt,
        this.context.messages,
        tools,
        { contextLength: error.contextSize },
        tokenizer
      )

      const retryMessages: ChatMessage[] = [
        { role: 'system', content: this.context.systemPrompt },
        ...refitted,
      ]

      return await provider.chat({ messages: retryMessages, tools, onToken })
    }
  }

  private async executeTools(toolCalls: ToolCall[]): Promise<Map<string, ToolResult>> {
    return this.toolExecutor.executeAll(toolCalls, this.context.workspaceDir)
  }

  getContext(): AgentContext {
    return this.context
  }

  clearContext(): void {
    this.context = createAgentContext(this.config, this.context.sessionId)
  }
}

export function createAgentLoop(
  config: RuntimeConfig,
  router: Router,
  toolExecutor: ToolExecutor,
  localProvider: LLMProvider,
  remoteProvider: LLMProvider | null,
  sessionId?: string
): AgentLoop {
  return new AgentLoop(
    config,
    router,
    toolExecutor,
    localProvider,
    remoteProvider,
    sessionId ?? crypto.randomUUID()
  )
}
