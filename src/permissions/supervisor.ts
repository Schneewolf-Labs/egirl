import type { MemoryManager } from '../memory'
import type { LLMProvider } from '../providers/types'
import { log } from '../util/logger'

export interface PermissionSupervisorConfig {
  mode: 'bypass' | 'supervised' | 'rules_only' | 'ask_user'
  defaultAction: 'allow' | 'deny' | 'ask_user'
  thinkBeforeDeciding: boolean
  minConfidence: number
  askUserBelowConfidence: boolean
  memoryRecall: boolean
  memoryWrite: boolean
  policy: {
    allow: string[]
    deny: string[]
    askUser: string[]
  }
}

export interface PermissionOption {
  id: string
  label: string
}

export interface PermissionRequest {
  backend: 'claude' | 'codex' | 'opencode'
  kind: 'permission' | 'question' | 'trust' | 'confirmation'
  originalTask: string
  workingDir: string
  promptText: string
  options?: PermissionOption[]
  toolName?: string
  toolInput?: unknown
  recentContext?: string
  riskHints?: string[]
}

export interface PermissionDecision {
  action: 'allow' | 'deny' | 'choose' | 'ask_user'
  optionId?: string
  answer?: string
  reason: string
  confidence: number
}

export interface PermissionSupervisorDeps {
  config: PermissionSupervisorConfig
  localProvider?: LLMProvider
  memory?: MemoryManager
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
}

function matchesPattern(pattern: string, request: PermissionRequest): boolean {
  const haystack = [
    request.backend,
    request.kind,
    request.toolName,
    request.workingDir,
    request.promptText,
    request.recentContext,
    JSON.stringify(request.toolInput ?? ''),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()

  return new RegExp(escapeRegex(pattern.toLowerCase())).test(haystack)
}

function decisionFromAction(
  action: PermissionDecision['action'],
  reason: string,
  optionId?: string,
): PermissionDecision {
  return {
    action,
    ...(optionId && { optionId }),
    reason,
    confidence: 1,
  }
}

/** A fixed action as a decision: `allow` picks the allow option when the prompt offers one. */
function fallbackDecision(
  request: PermissionRequest,
  action: 'allow' | 'deny' | 'ask_user',
  reason: string,
): PermissionDecision {
  const optionId = action === 'allow' ? optionForAction(request, 'allow') : undefined
  return decisionFromAction(optionId ? 'choose' : action, reason, optionId)
}

function optionForAction(request: PermissionRequest, action: 'allow' | 'deny'): string | undefined {
  const options = request.options ?? []
  const preferred =
    action === 'allow'
      ? ['allow', 'yes', 'approve', 'continue', 'trust']
      : ['deny', 'no', 'reject', 'cancel', 'do not', "don't"]

  return (
    options.find((option) => preferred.some((word) => option.label.toLowerCase().includes(word)))
      ?.id ?? options[0]?.id
  )
}

function applyRules(
  config: PermissionSupervisorConfig,
  request: PermissionRequest,
): PermissionDecision | undefined {
  if (config.policy.deny.some((pattern) => matchesPattern(pattern, request))) {
    return decisionFromAction('deny', 'Denied by permission_supervisor.policy.deny')
  }

  if (config.policy.askUser.some((pattern) => matchesPattern(pattern, request))) {
    return decisionFromAction('ask_user', 'User approval required by policy')
  }

  if (config.policy.allow.some((pattern) => matchesPattern(pattern, request))) {
    const optionId = optionForAction(request, 'allow')
    return decisionFromAction(optionId ? 'choose' : 'allow', 'Allowed by policy', optionId)
  }

  return undefined
}

function parseDecisionJson(
  content: string,
  request: PermissionRequest,
): PermissionDecision | undefined {
  const match = content.match(/\{[\s\S]*\}/)
  if (!match) return undefined

  const parsed = JSON.parse(match[0]) as Partial<PermissionDecision>
  const action = parsed.action
  if (action !== 'allow' && action !== 'deny' && action !== 'choose' && action !== 'ask_user') {
    return undefined
  }

  const optionId =
    parsed.optionId && request.options?.some((option) => option.id === parsed.optionId)
      ? parsed.optionId
      : undefined

  return {
    action,
    ...(optionId && { optionId }),
    ...(parsed.answer && { answer: parsed.answer }),
    reason: parsed.reason ?? 'No reason provided',
    confidence:
      typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5,
  }
}

async function recallMemory(
  memory: MemoryManager | undefined,
  request: PermissionRequest,
): Promise<string> {
  if (!memory) return ''

  try {
    const query = [
      'permission policy',
      request.backend,
      request.kind,
      request.toolName,
      request.promptText.slice(0, 500),
    ]
      .filter(Boolean)
      .join(' ')
    const results = await memory.searchHybrid(query, {
      limit: 4,
      categories: ['preference', 'project'],
    })
    return results.map((result) => `- ${result.memory.key}: ${result.memory.value}`).join('\n')
  } catch (error) {
    log.warn('permissions', `Memory recall failed: ${error}`)
    return ''
  }
}

async function writeMemory(
  memory: MemoryManager | undefined,
  request: PermissionRequest,
  decision: PermissionDecision,
): Promise<void> {
  if (!memory) return

  try {
    const key = `permission:${request.backend}:${Date.now()}`
    await memory.set(
      key,
      [
        `${request.backend} ${request.kind} decision: ${decision.action}`,
        decision.optionId ? `option=${decision.optionId}` : undefined,
        `reason=${decision.reason}`,
        `task=${request.originalTask.slice(0, 200)}`,
      ]
        .filter(Boolean)
        .join('; '),
      { category: 'project', source: 'auto' },
    )
  } catch (error) {
    log.warn('permissions', `Memory write failed: ${error}`)
  }
}

export class PermissionSupervisor {
  constructor(private deps: PermissionSupervisorDeps) {}

  /** Whether the supervisor should intercept permission requests at all. */
  isActive(): boolean {
    return this.deps.config.mode !== 'bypass'
  }

  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    const { config } = this.deps

    if (config.mode === 'bypass') {
      return fallbackDecision(request, 'allow', 'Permission supervisor bypassed')
    }

    if (config.mode === 'ask_user') {
      return decisionFromAction('ask_user', 'Permission supervisor configured to ask user')
    }

    const ruleDecision = applyRules(config, request)
    if (ruleDecision) return ruleDecision

    if (config.mode === 'rules_only' || !this.deps.localProvider) {
      return fallbackDecision(
        request,
        config.defaultAction,
        'No rule matched; used default permission action',
      )
    }

    const memoryContext = config.memoryRecall ? await recallMemory(this.deps.memory, request) : ''
    const options =
      request.options?.map((option) => `${option.id}. ${option.label}`).join('\n') ?? ''

    const systemPrompt = [
      'You are egirl permission supervisor.',
      config.thinkBeforeDeciding
        ? 'Think through task relevance and risk before deciding, but respond only with JSON.'
        : 'Decide directly and respond only with JSON.',
      'Allow ordinary reads, writes, edits, and safe commands needed for the original coding task.',
      'Deny destructive actions, secret access, or unrelated network access unless explicitly required.',
      'Use ask_user when the request is high risk, ambiguous, or outside the task.',
      'When you deny, write the reason as concrete guidance the agent can act on, so it re-steers and retries correctly instead of just stopping.',
      'Return JSON: {"action":"allow|deny|choose|ask_user","optionId":"...","reason":"...","confidence":0.0}',
    ].join('\n')

    const userPrompt = [
      `Backend: ${request.backend}`,
      `Kind: ${request.kind}`,
      `Working directory: ${request.workingDir}`,
      `Original task: ${request.originalTask}`,
      request.toolName ? `Tool: ${request.toolName}` : undefined,
      request.toolInput ? `Tool input: ${JSON.stringify(request.toolInput)}` : undefined,
      options ? `Options:\n${options}` : undefined,
      memoryContext ? `Relevant memories:\n${memoryContext}` : undefined,
      request.recentContext ? `Recent context:\n${request.recentContext}` : undefined,
      `Prompt:\n${request.promptText.slice(-3000)}`,
      'Decision JSON:',
    ]
      .filter(Boolean)
      .join('\n\n')

    try {
      const response = await this.deps.localProvider.chat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 200,
      })

      const decision = parseDecisionJson(response.content, request)
      if (!decision) throw new Error(`Invalid decision JSON: ${response.content}`)

      if (config.askUserBelowConfidence && decision.confidence < config.minConfidence) {
        return decisionFromAction(
          'ask_user',
          `Decision confidence ${decision.confidence.toFixed(2)} below threshold ${config.minConfidence.toFixed(2)}`,
        )
      }

      if (decision.action === 'allow' && request.options?.length) {
        decision.action = 'choose'
        decision.optionId = optionForAction(request, 'allow')
      }

      if (config.memoryWrite) await writeMemory(this.deps.memory, request, decision)
      return decision
    } catch (error) {
      log.warn('permissions', `Local model decision failed: ${error}`)
      return fallbackDecision(
        request,
        config.defaultAction,
        'Local model decision failed; used default permission action',
      )
    }
  }
}

export function createPermissionSupervisor(deps: PermissionSupervisorDeps): PermissionSupervisor {
  return new PermissionSupervisor(deps)
}
