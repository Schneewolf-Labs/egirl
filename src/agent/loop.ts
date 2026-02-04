import type { ChatMessage, ChatResponse, LLMProvider, ToolCall } from '../providers/types'
import type { EgirlConfig } from '../config'
import type { ToolExecutor, ToolContext, ToolResult } from '../tools'
import { ModelRouter, shouldRetryWithRemote } from '../routing'
import { createAgentContext, addMessage, getMessagesWithSystem, type AgentContext } from './context'
import { handleStream, type StreamHandler } from './streaming'
import { log } from '../utils/logger'

export interface AgentLoopOptions {
  maxTurns?: number
  stream?: boolean
  streamHandler?: StreamHandler
}

export interface AgentResponse {
  content: string
  model: 'local' | 'remote'
  provider: string
  usage: {
    inputTokens: number
    outputTokens: number
  }
  escalated: boolean
  turns: number
}

export class AgentLoop {
  private config: EgirlConfig
  private router: ModelRouter
  private toolExecutor: ToolExecutor
  private localProvider: LLMProvider | null
  private remoteProvider: LLMProvider | null
  private context: AgentContext

  constructor(
    config: EgirlConfig,
    router: ModelRouter,
    toolExecutor: ToolExecutor,
    localProvider: LLMProvider | null,
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
    const { maxTurns = 10, stream = false, streamHandler } = options

    // Add user message to context
    addMessage(this.context, { role: 'user', content: userMessage })

    // Route the request
    const routingDecision = this.router.route(this.context.messages, this.toolExecutor.listTools())

    let provider = routingDecision.model === 'local' ? this.localProvider : this.remoteProvider

    // Fallback to local if remote not available
    if (!provider && routingDecision.model === 'remote') {
      log.warn('agent', 'Remote provider not available, falling back to local')
      provider = this.localProvider
    }

    if (!provider) {
      throw new Error('No LLM provider available')
    }

    let turns = 0
    let escalated = false
    let totalUsage = { inputTokens: 0, outputTokens: 0 }
    let finalContent = ''
    let currentProvider = provider

    while (turns < maxTurns) {
      turns++

      const messages = getMessagesWithSystem(this.context)
      const tools = this.toolExecutor.getDefinitions()

      log.debug('agent', `Turn ${turns}: sending ${messages.length} messages to ${currentProvider.name}`)

      let response: ChatResponse

      if (stream && currentProvider.chatStream) {
        const streamResult = await handleStream(
          currentProvider.chatStream({ messages, tools }),
          streamHandler ?? {}
        )

        response = {
          content: streamResult.content,
          toolCalls: streamResult.toolCalls.length > 0 ? streamResult.toolCalls : undefined,
          usage: { inputTokens: 0, outputTokens: 0 },  // Stream might not have usage
          model: currentProvider.name,
          provider: currentProvider.type,
        }
      } else {
        response = await currentProvider.chat({ messages, tools })
      }

      totalUsage.inputTokens += response.usage.inputTokens
      totalUsage.outputTokens += response.usage.outputTokens

      // Check for escalation if we're using local
      if (currentProvider.type === 'local' && this.remoteProvider) {
        if (shouldRetryWithRemote(response, this.config.routing.escalationThreshold)) {
          log.info('agent', 'Escalating to remote model')
          currentProvider = this.remoteProvider
          escalated = true
          continue  // Retry with remote
        }
      }

      // Handle tool calls
      if (response.toolCalls && response.toolCalls.length > 0) {
        // Add assistant message with tool calls
        addMessage(this.context, {
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        })

        // Execute tools
        const toolResults = await this.executeTools(response.toolCalls)

        // Add tool results as messages
        for (const [callId, result] of toolResults) {
          addMessage(this.context, {
            role: 'tool',
            content: result.output,
            toolCallId: callId,
          })

          // Check if tool suggests escalation
          if (result.suggestEscalation && currentProvider.type === 'local' && this.remoteProvider) {
            log.info('agent', `Tool suggests escalation: ${result.escalationReason}`)
            currentProvider = this.remoteProvider
            escalated = true
          }
        }

        continue  // Continue loop to get next response
      }

      // No tool calls, we have a final response
      finalContent = response.content
      addMessage(this.context, { role: 'assistant', content: finalContent })
      break
    }

    return {
      content: finalContent,
      model: currentProvider.type,
      provider: currentProvider.name,
      usage: totalUsage,
      escalated,
      turns,
    }
  }

  private async executeTools(toolCalls: ToolCall[]): Promise<Map<string, ToolResult>> {
    const toolContext: ToolContext = {
      workspaceDir: this.context.workspaceDir,
      sessionId: this.context.sessionId,
      currentModel: 'local',  // TODO: Track actual current model
    }

    return this.toolExecutor.executeAll(toolCalls, toolContext)
  }

  getContext(): AgentContext {
    return this.context
  }

  clearContext(): void {
    this.context = createAgentContext(this.config, this.context.sessionId)
  }
}

export function createAgentLoop(
  config: EgirlConfig,
  router: ModelRouter,
  toolExecutor: ToolExecutor,
  localProvider: LLMProvider | null,
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
