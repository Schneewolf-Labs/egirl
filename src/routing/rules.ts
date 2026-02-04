import type { EgirlConfig } from '../config'

export interface RoutingRule {
  name: string
  match: (context: RuleContext) => boolean
  target: 'local' | 'remote'
  priority: number
}

export interface RuleContext {
  taskType?: string
  toolsInvolved?: string[]
  estimatedTokens?: number
  complexity?: 'trivial' | 'simple' | 'moderate' | 'complex'
  userContent: string
}

export function createRoutingRules(config: EgirlConfig): RoutingRule[] {
  const rules: RoutingRule[] = []

  // Always local rules
  for (const pattern of config.routing.alwaysLocal) {
    rules.push({
      name: `always_local_${pattern}`,
      match: (ctx) => ctx.toolsInvolved?.includes(pattern) ?? false,
      target: 'local',
      priority: 100,
    })
  }

  // Always remote rules
  for (const pattern of config.routing.alwaysRemote) {
    rules.push({
      name: `always_remote_${pattern}`,
      match: (ctx) => ctx.taskType === pattern || (ctx.toolsInvolved?.includes(pattern) ?? false),
      target: 'remote',
      priority: 100,
    })
  }

  // Complexity-based rules
  rules.push({
    name: 'trivial_local',
    match: (ctx) => ctx.complexity === 'trivial',
    target: 'local',
    priority: 50,
  })

  rules.push({
    name: 'complex_remote',
    match: (ctx) => ctx.complexity === 'complex',
    target: 'remote',
    priority: 50,
  })

  // Token-based rules
  rules.push({
    name: 'large_context_remote',
    match: (ctx) => (ctx.estimatedTokens ?? 0) > config.local.contextLength * 0.8,
    target: 'remote',
    priority: 75,
  })

  // Default rule based on config
  rules.push({
    name: 'default',
    match: () => true,
    target: config.routing.defaultModel,
    priority: 0,
  })

  return rules.sort((a, b) => b.priority - a.priority)
}

export function applyRules(rules: RoutingRule[], context: RuleContext): { target: 'local' | 'remote'; rule: string } {
  for (const rule of rules) {
    if (rule.match(context)) {
      return { target: rule.target, rule: rule.name }
    }
  }
  // Should never reach here since we have a default rule
  return { target: 'local', rule: 'fallback' }
}
