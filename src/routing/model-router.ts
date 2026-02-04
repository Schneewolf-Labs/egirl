import type { ChatMessage } from '../providers/types'
import type { EgirlConfig } from '../config'
import { analyzeMessageHeuristics, estimateComplexity } from './heuristics'
import { createRoutingRules, applyRules, type RuleContext } from './rules'
import { log } from '../utils/logger'

export interface RoutingDecision {
  model: 'local' | 'remote'
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

export class ModelRouter {
  private config: EgirlConfig
  private rules: ReturnType<typeof createRoutingRules>

  constructor(config: EgirlConfig) {
    this.config = config
    this.rules = createRoutingRules(config)
  }

  route(messages: ChatMessage[], toolsAvailable?: string[]): RoutingDecision {
    const lastMessage = messages[messages.length - 1]
    if (!lastMessage) {
      return {
        model: 'local',
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
    let finalModel: 'local' | 'remote' = ruleResult.target
    let finalReason = ruleResult.rule
    let finalConfidence = heuristics.confidence

    // If heuristics strongly suggest escalation
    if (heuristics.shouldEscalate && heuristics.confidence > 0.7) {
      finalModel = 'remote'
      finalReason = heuristics.reason ?? 'heuristic_escalation'
      finalConfidence = heuristics.confidence
    }

    // Check if we have a remote provider
    if (finalModel === 'remote' && !this.config.remote.anthropic && !this.config.remote.openai) {
      log.warn('routing', 'Remote model requested but no remote provider configured, falling back to local')
      finalModel = 'local'
      finalReason = 'no_remote_provider'
      finalConfidence = 0.5
    }

    const decision: RoutingDecision = {
      model: finalModel,
      reason: finalReason,
      confidence: finalConfidence,
    }

    if (finalModel === 'remote') {
      if (this.config.remote.anthropic) {
        decision.provider = `anthropic/${this.config.remote.anthropic.defaultModel}`
      } else if (this.config.remote.openai) {
        decision.provider = `openai/${this.config.remote.openai.defaultModel}`
      }
    } else {
      decision.provider = `${this.config.local.provider}/${this.config.local.model}`
    }

    log.debug('routing', `Routed to ${decision.model}: ${decision.reason} (confidence: ${decision.confidence})`)

    return decision
  }

  private estimateTokens(messages: ChatMessage[]): number {
    // Rough estimate: ~4 characters per token
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
      skillsInvolved: [],  // TODO: Detect skills from content
    }
  }
}

export function createModelRouter(config: EgirlConfig): ModelRouter {
  return new ModelRouter(config)
}
