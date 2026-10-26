import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { RuntimeConfig } from '../config'
import type { ChatMessage, ToolDefinition } from '../providers/types'
import type { Skill } from '../skills/types'
import { log } from '../util/logger'
import { buildToolsSection } from './tool-prompt'

export interface AgentContext {
  systemPrompt: string
  /** Stable portion of the system prompt (personality, tools, skills) — cache-eligible */
  stablePromptPrefix: string
  /** Volatile portion (working memory, additional context) — changes per session */
  volatilePromptSuffix: string
  messages: ChatMessage[]
  workspaceDir: string
  sessionId: string
  conversationSummary?: string
  /** Paths of the images attached to the message this run is answering; cleared when it ends. */
  runImages?: string[]
  /** Text of the user message this run is answering (the egress guard reads it); cleared when it ends. */
  runUserText?: string
}

/**
 * Load a workspace file, return empty string if not found
 */
function loadWorkspaceFile(workspaceDir: string, filename: string): string {
  const filepath = join(workspaceDir, filename)
  try {
    if (existsSync(filepath)) {
      return readFileSync(filepath, 'utf-8')
    }
  } catch (error) {
    log.warn('context', `Failed to load ${filename}:`, error)
  }
  return ''
}

export interface SystemPromptOptions {
  skills?: Skill[]
  additionalContext?: string
  /** Clock for the date line; tests pin it. */
  now?: Date
  /** The tools the model is handed; the prompt describes exactly these. */
  tools?: ToolDefinition[]
}

export interface SystemPromptParts {
  full: string
  stable: string
  volatile: string
}

/**
 * Build system prompt from workspace personality files.
 * Returns the full prompt and its stable/volatile parts for caching.
 */
export function buildSystemPrompt(
  config: RuntimeConfig,
  options: SystemPromptOptions = {},
): SystemPromptParts {
  const { path: workspaceDir } = config.workspace
  const { skills, additionalContext } = options

  // Load personality files
  const identity = loadWorkspaceFile(workspaceDir, 'IDENTITY.md')
  const soul = loadWorkspaceFile(workspaceDir, 'SOUL.md')
  const agents = loadWorkspaceFile(workspaceDir, 'AGENTS.md')
  const user = loadWorkspaceFile(workspaceDir, 'USER.md')
  const memory = loadWorkspaceFile(workspaceDir, 'MEMORY.md')

  // Build prompt from loaded files — separated into stable (cache-eligible) and volatile parts
  const stableSections: string[] = []
  const volatileSections: string[] = []

  if (identity) {
    stableSections.push(identity)
  }

  if (soul) {
    stableSections.push(soul)
  }

  if (agents) {
    stableSections.push(agents)
  }

  if (user?.includes(':') && !user.includes(':\n\n')) {
    // Only include USER.md if it has actual content (not just template)
    stableSections.push(user)
  }

  // Tier 1 memory: MEMORY.md is always-on working memory loaded every message.
  // Keep this file small and curated — everything else is Tier 2 (vector search).
  // Classified as volatile since it can change between sessions.
  if (memory.trim()) {
    volatileSections.push(`## Working Memory\n\n${memory.trim()}`)
  }

  // Add tool capabilities: exactly the tools this session hands the model
  const toolsSection = buildToolsSection(workspaceDir, options.tools ?? [])
  if (toolsSection) stableSections.push(toolsSection)

  // Add skills (stable — loaded once from skill files)
  if (skills && skills.length > 0) {
    stableSections.push(buildSkillsSection(skills))
  }

  // Add any additional context (volatile — can change per session)
  if (additionalContext) {
    volatileSections.push(additionalContext)
  }

  const hasPromptContent = stableSections.length + volatileSections.length > (toolsSection ? 1 : 0)

  // Today's date. Without it the model dates changelogs, notes and reports by guesswork (a
  // deployment shipped a release section dated eleven days early and a report dated six weeks
  // late on the same day). Volatile, so it sits after the cached stable prefix.
  const dateLine = `Current date: ${formatCurrentDate(options.now ?? new Date())}`

  // Fallback if no personality files loaded
  if (!hasPromptContent) {
    log.warn('context', 'No personality files found, using minimal prompt')
    const minimal =
      'You are Kira, a helpful AI assistant. Be concise, direct, and use tools when needed.'
    const stable = toolsSection ? `${minimal}\n\n${toolsSection}` : minimal
    return { full: `${stable}\n\n---\n\n${dateLine}`, stable, volatile: dateLine }
  }
  volatileSections.push(dateLine)

  const separator = '\n\n---\n\n'
  const stable = stableSections.join(separator)
  const volatile = volatileSections.join(separator)
  const full = volatile ? `${stable}${separator}${volatile}` : stable

  return { full, stable, volatile }
}

/** "2026-10-06 (Tuesday)" in the local timezone: what a person means by "today". */
export function formatCurrentDate(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' })
  return `${y}-${m}-${d} (${weekday})`
}

/**
 * Build the skills section for the system prompt
 */
function buildSkillsSection(skills: Skill[]): string {
  // Names and descriptions only. The body arrives via `skill_read` when a skill is actually
  // needed -- see src/tools/builtin/skill.ts for why this is not simply inlined.
  const lines: string[] = [
    '## Available Skills',
    '',
    'These are what you know how to do. The instructions are not here: call `skill_read` with the',
    'skill name to load them before you act on one. When you develop a reusable procedure — or',
    'find a skill is wrong or missing a step — use `skill_manage` to create or patch it (prefer',
    'patching a skill you actually used over creating a near-duplicate).',
    '',
  ]

  for (const skill of skills) {
    const emoji = skill.metadata.openclaw?.emoji ?? ''
    const prefix = emoji ? `${emoji} ` : ''
    const description = skill.description || '(no description)'
    lines.push(`- **${prefix}${skill.name}** — ${description}`)
  }

  return lines.join('\n')
}

export function createAgentContext(
  config: RuntimeConfig,
  sessionId: string,
  options: SystemPromptOptions = {},
): AgentContext {
  const parts = buildSystemPrompt(config, options)

  log.debug(
    'context',
    `Built system prompt (${parts.full.length} chars, stable: ${parts.stable.length}, volatile: ${parts.volatile.length})`,
  )

  return {
    systemPrompt: parts.full,
    stablePromptPrefix: parts.stable,
    volatilePromptSuffix: parts.volatile,
    messages: [],
    workspaceDir: config.workspace.path,
    sessionId,
  }
}

export function addMessage(context: AgentContext, message: ChatMessage): void {
  context.messages.push(message)
}
