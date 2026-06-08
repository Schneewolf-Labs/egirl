import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { RuntimeConfig } from '../config'
import type { ChatMessage } from '../providers/types'
import type { Skill } from '../skills/types'
import { log } from '../util/logger'

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

  // Add tool capabilities
  stableSections.push(`## Available Tools

Your workspace directory is \`${workspaceDir}\`. All relative file paths are resolved against this directory — not the user's shell cwd. When you write or read files with relative paths, they go in the workspace. Use absolute paths when working outside of it.

You have access to these tools:

**Files:**
- \`read_file\` - Read file contents (supports line ranges)
- \`write_file\` - Write content to a file (creates directories)
- \`edit_file\` - Edit a file with exact string replacement
- \`glob_files\` - Find files matching a glob pattern

**System:**
- \`execute_command\` - Run shell commands
- \`screenshot\` - Capture a screenshot of the current display

**Git:**
- \`git_status\` - Show repository state (branch, staged/unstaged/untracked)
- \`git_diff\` - Show diffs (staged, unstaged, or between refs)
- \`git_log\` - Show commit history
- \`git_commit\` - Stage files and create a commit
- \`git_show\` - Show a specific commit's contents and diff

**Memory:**
- \`memory_search\` - Search memories (hybrid keyword + semantic, with category and time filters)
- \`memory_get\` - Retrieve a specific memory by key
- \`memory_set\` - Store a memory with optional category (fact, preference, decision, project, entity)
- \`memory_delete\` - Delete a memory by key
- \`memory_list\` - List stored memories (filterable by category and source)
- \`memory_recall\` - Recall memories from a time period ("last week", "3 days ago", etc.)

**Web:**
- \`web_research\` - Fetch a URL and return its text content

**Delegation (primary):**
- \`code_agent\` - Delegate coding work to the configured code agent (multi-file edits, refactoring, debugging, test writing, reading unfamiliar code). This is your main tool for project work. Refer to this as "the code agent" when talking to the user — never say "code_agent".

Use tools proactively to gather information rather than asking. Use git tools directly instead of running git via execute_command. **Delegate coding work to the code agent by default — you're the human-in-the-loop, not a code generator.** Only use edit_file directly for trivial single-line changes you're certain about.

**Important:** When you decide to use a tool, call it immediately in the same response — do not narrate your intention first. Never say "I'll use X tool" or "Let me run Y" and then stop. Just call the tool.`)

  // Add skills (stable — loaded once from skill files)
  if (skills && skills.length > 0) {
    stableSections.push(buildSkillsSection(skills))
  }

  // Add any additional context (volatile — can change per session)
  if (additionalContext) {
    volatileSections.push(additionalContext)
  }

  const allSections = [...stableSections, ...volatileSections]

  // Fallback if no personality files loaded
  if (allSections.length === 1) {
    log.warn('context', 'No personality files found, using minimal prompt')
    const full = `You are Kira, a helpful AI assistant. Be concise, direct, and use tools when needed.\n\n${allSections[0]}`
    return { full, stable: full, volatile: '' }
  }

  const separator = '\n\n---\n\n'
  const stable = stableSections.join(separator)
  const volatile = volatileSections.join(separator)
  const full = volatile ? `${stable}${separator}${volatile}` : stable

  return { full, stable, volatile }
}

/**
 * Build the skills section for the system prompt
 */
function buildSkillsSection(skills: Skill[]): string {
  const lines: string[] = ['## Available Skills', '']

  for (const skill of skills) {
    const emoji = skill.metadata.openclaw?.emoji ?? ''
    const prefix = emoji ? `${emoji} ` : ''
    lines.push(`### ${prefix}${skill.name}`)
    if (skill.description) {
      lines.push(skill.description)
    }
    lines.push('')
    lines.push(skill.content)
    lines.push('')
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

export function getMessagesWithSystem(context: AgentContext): ChatMessage[] {
  return [{ role: 'system', content: context.systemPrompt }, ...context.messages]
}
