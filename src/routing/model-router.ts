import type { ChatMessage } from '../providers/types'
import type { RuntimeConfig } from '../config'
import { analyzeMessageHeuristics, estimateComplexity } from './heuristics'
import { createRoutingRules, applyRules, type RuleContext } from './rules'
import { log } from '../util/logger'

export interface RoutingDecision {
  target: 'local' | 'remote'
  provider?: string
  reason: string
  confidence: number
}

export interface TaskAnalysis {
  type: 'conversation' | 'tool_use' | 'code_generation' | 'reasoning' | 'memory_op'
  complexity: 'trivial' | 'simple' | 'moderate' | 'complex'
  estimatedTokens: number
  skillsInvolved: string[]
}

export class Router {
  private config: RuntimeConfig
  private rules: ReturnType<typeof createRoutingRules>

  constructor(config: RuntimeConfig) {
    this.config = config
    this.rules = createRoutingRules(config)
  }

  route(messages: ChatMessage[], toolsAvailable?: string[]): RoutingDecision {
    const lastMessage = messages[messages.length - 1]
    if (!lastMessage) {
      return {
        target: 'local',
        reason: 'no_message',
        confidence: 1.0,
      }
    }

    // Quick heuristic analysis
    const heuristics = analyzeMessageHeuristics(messages)

    // Estimate complexity
    const complexity = estimateComplexity(lastMessage.content)

    // Estimate token count (rough approximation)
    const estimatedTokens = this.estimateTokens(messages)

    // Detect task type
    const taskType = this.detectTaskType(lastMessage.content)

    // Build rule context
    const context: RuleContext = {
      taskType,
      toolsInvolved: toolsAvailable,
      estimatedTokens,
      complexity,
      userContent: lastMessage.content,
    }

    // Apply rules
    const ruleResult = applyRules(this.rules, context)

    // Combine heuristics and rules
    let finalTarget: 'local' | 'remote' = ruleResult.target
    let finalReason = ruleResult.rule
    let finalConfidence = heuristics.confidence

    // If heuristics strongly suggest escalation
    if (heuristics.shouldEscalate && heuristics.confidence > 0.7) {
      finalTarget = 'remote'
      finalReason = heuristics.reason ?? 'heuristic_escalation'
      finalConfidence = heuristics.confidence
    }

    // Check if we have a remote provider
    if (finalTarget === 'remote' && !this.config.remote.anthropic && !this.config.remote.openai) {
      log.warn('routing', 'Remote model requested but no remote provider configured, falling back to local')
      finalTarget = 'local'
      finalReason = 'no_remote_provider'
      finalConfidence = 0.5
    }

    const decision: RoutingDecision = {
      target: finalTarget,
      reason: finalReason,
      confidence: finalConfidence,
    }

    if (finalTarget === 'remote') {
      if (this.config.remote.anthropic) {
        decision.provider = `anthropic/${this.config.remote.anthropic.model}`
      } else if (this.config.remote.openai) {
        decision.provider = `openai/${this.config.remote.openai.model}`
      }
    } else {
      decision.provider = `llamacpp/${this.config.local.model}`
    }

    log.debug('routing', `Routed to ${decision.target}: ${decision.reason} (confidence: ${decision.confidence})`)

    return decision
  }

  private estimateTokens(messages: ChatMessage[]): number {
    let totalChars = 0
    for (const msg of messages) {
      totalChars += msg.content.length
    }
    return Math.ceil(totalChars / 4)
  }

  private detectTaskType(content: string): TaskAnalysis['type'] {
    const lower = content.toLowerCase()

    if (lower.includes('remember') || lower.includes('recall') || lower.includes('what did i')) {
      return 'memory_op'
    }

    if (lower.includes('write code') || lower.includes('implement') ||
        lower.includes('create a function') || lower.includes('```')) {
      return 'code_generation'
    }

    if (lower.includes('read file') || lower.includes('execute') ||
        lower.includes('run command') || lower.includes('search for')) {
      return 'tool_use'
    }

    if (lower.includes('explain') || lower.includes('analyze') ||
        lower.includes('why') || lower.includes('how does')) {
      return 'reasoning'
    }

    return 'conversation'
  }

  analyzeTask(messages: ChatMessage[]): TaskAnalysis {
    const lastMessage = messages[messages.length - 1]
    const content = lastMessage?.content ?? ''

    return {
      type: this.detectTaskType(content),
      complexity: estimateComplexity(content),
      estimatedTokens: this.estimateTokens(messages),
      skillsInvolved: [],
    }
  }
}

export function createRouter(config: RuntimeConfig): Router {
  return new Router(config)
}
