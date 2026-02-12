import type { ChatMessage, ChatResponse, LLMProvider, ToolCall } from '../providers/types'
import type { RuntimeConfig } from '../config'
import type { ToolExecutor, ToolResult } from '../tools'
import { Router, shouldRetryWithRemote } from '../routing'
import { createAgentContext, addMessage, getMessagesWithSystem, type AgentContext } from './context'
import { log } from '../util/logger'

export interface AgentLoopOptions {
  maxTurns?: number
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
  }

  async run(userMessage: string, options: AgentLoopOptions = {}): Promise<AgentResponse> {
    const { maxTurns = 10 } = options

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

      const messages = getMessagesWithSystem(this.context)
      const tools = this.toolExecutor.getDefinitions()

      log.debug('agent', `Turn ${turns}: sending ${messages.length} messages to ${currentProvider.name}`)

      const response = await currentProvider.chat({ messages, tools })

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

        const toolResults = await this.executeTools(response.tool_calls)

        for (const [callId, result] of toolResults) {
          log.debug('agent', `Tool ${callId}: ${result.output.substring(0, 100)}${result.output.length > 100 ? '...' : ''}`)
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
