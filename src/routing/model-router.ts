import type { ChatMessage } from '../providers/types'
import { getTextContent } from '../providers/types'
import type { RuntimeConfig } from '../config'
import type { Skill } from '../skills/types'
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
  private skills: Skill[] = []

  constructor(config: RuntimeConfig, skills?: Skill[]) {
    this.config = config
    this.rules = createRoutingRules(config)
    if (skills) {
      this.skills = skills
    }
  }

  setSkills(skills: Skill[]): void {
    this.skills = skills
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

    const lastContent = getTextContent(lastMessage.content)

    // Quick heuristic analysis
    const heuristics = analyzeMessageHeuristics(messages)

    // Estimate complexity
    const complexity = estimateComplexity(lastContent)

    // Estimate token count (rough approximation)
    const estimatedTokens = this.estimateTokens(messages)

    // Detect task type
    const taskType = this.detectTaskType(lastContent)

    // Detect which tools the message likely involves (not all registered tools)
    const likelyTools = this.detectLikelyTools(lastContent, toolsAvailable ?? [])

    // Check if any skills match and have routing preferences
    const matchedSkills = this.matchSkills(lastMessage.content)

    // Build rule context
    const context: RuleContext = {
      taskType,
      toolsInvolved: likelyTools.length > 0 ? likelyTools : undefined,
      estimatedTokens,
      complexity,
      userContent: lastContent,
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

    // Skill-based routing override
    for (const skill of matchedSkills) {
      const skillComplexity = skill.metadata.egirl?.complexity
      if (skillComplexity === 'remote') {
        finalTarget = 'remote'
        finalReason = `skill:${skill.name}`
        break
      } else if (skillComplexity === 'local') {
        finalTarget = 'local'
        finalReason = `skill:${skill.name}`
        break
      }
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
      totalChars += getTextContent(msg.content).length
    }
    return Math.ceil(totalChars / 4)
  }

  /** Map message content to tools it likely references */
  private detectLikelyTools(content: string, available: string[]): string[] {
    const lower = content.toLowerCase()
    const toolHints: Record<string, string[]> = {
      memory_search: ['remember', 'recall', 'what did i', 'do you remember', 'search memory'],
      memory_get: ['recall', 'retrieve', 'get memory'],
      memory_set: ['remember this', 'remember that', 'store this', 'save this'],
      read_file: ['read file', 'show file', 'cat ', 'open file', 'look at file'],
      write_file: ['write file', 'create file', 'save file', 'write to'],
      edit_file: ['edit file', 'change file', 'modify file', 'replace in'],
      execute_command: ['run command', 'execute', 'run script', 'shell'],
      glob_files: ['find file', 'list file', 'search file', 'glob'],
      web_research: ['fetch url', 'web search', 'look up', 'browse'],
      code_agent: ['refactor', 'fix the code', 'debug this', 'multi-file', 'rewrite'],
    }

    const detected: string[] = []
    for (const [tool, hints] of Object.entries(toolHints)) {
      if (available.includes(tool) && hints.some(h => lower.includes(h))) {
        detected.push(tool)
      }
    }
    return detected
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
    const content = lastMessage ? getTextContent(lastMessage.content) : ''
    const matched = this.matchSkills(content)

    return {
      type: this.detectTaskType(content),
      complexity: estimateComplexity(content),
      estimatedTokens: this.estimateTokens(messages),
      skillsInvolved: matched.map(s => s.name),
    }
  }

  private matchSkills(content: string): Skill[] {
    if (this.skills.length === 0) return []

    const lower = content.toLowerCase()
    const matched: Skill[] = []

    for (const skill of this.skills) {
      const nameLower = skill.name.toLowerCase()
      // Match against skill name (split into words for flexible matching)
      const nameWords = nameLower.split(/[\s-]+/)
      const isNameMatch = nameWords.some(word => word.length > 2 && lower.includes(word))

      if (isNameMatch) {
        matched.push(skill)
        continue
      }

      // Match against escalation triggers from metadata
      const triggers = skill.metadata.egirl?.escalationTriggers ?? []
      const isTriggerMatch = triggers.some(t => lower.includes(t.toLowerCase()))
      if (isTriggerMatch) {
        matched.push(skill)
      }
    }

    return matched
  }
}

export function createRouter(config: RuntimeConfig, skills?: Skill[]): Router {
  return new Router(config, skills)
}
