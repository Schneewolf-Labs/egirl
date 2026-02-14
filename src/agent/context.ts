import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { ChatMessage } from '../providers/types'
import type { RuntimeConfig } from '../config'
import type { Skill } from '../skills/types'
import { log } from '../util/logger'

export interface AgentContext {
  systemPrompt: string
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

/**
 * Build system prompt from workspace personality files
 */
export function buildSystemPrompt(config: RuntimeConfig, options: SystemPromptOptions = {}): string {
  const { path: workspaceDir } = config.workspace
  const { skills, additionalContext } = options

  // Load personality files
  const identity = loadWorkspaceFile(workspaceDir, 'IDENTITY.md')
  const soul = loadWorkspaceFile(workspaceDir, 'SOUL.md')
  const agents = loadWorkspaceFile(workspaceDir, 'AGENTS.md')
  const user = loadWorkspaceFile(workspaceDir, 'USER.md')

  // Build prompt from loaded files
  const sections: string[] = []

  if (identity) {
    sections.push(identity)
  }

  if (soul) {
    sections.push(soul)
  }

  if (agents) {
    sections.push(agents)
  }

  if (user && user.includes(':') && !user.includes(':\n\n')) {
    // Only include USER.md if it has actual content (not just template)
    sections.push(user)
  }

  // Add tool capabilities
  sections.push(`## Available Tools

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
- \`memory_search\` - Search memories (hybrid keyword + semantic)
- \`memory_get\` - Retrieve a specific memory by key
- \`memory_set\` - Store a memory for later recall
- \`memory_delete\` - Delete a memory by key
- \`memory_list\` - List all stored memories

**Web:**
- \`web_research\` - Fetch a URL and return its text content

**Delegation:**
- \`code_agent\` - Delegate complex coding tasks to Claude Code (multi-file edits, refactoring, debugging)

Use tools proactively to gather information rather than asking. Use git tools directly instead of running git via execute_command. Delegate coding tasks to code_agent by default — you're a coordinator, not a code generator. Only use edit_file directly for trivial single-line changes you're certain about.`)

  // Add skills
  if (skills && skills.length > 0) {
    sections.push(buildSkillsSection(skills))
  }

  // Add any additional context
  if (additionalContext) {
    sections.push(additionalContext)
  }

  // Fallback if no personality files loaded
  if (sections.length === 1) {
    log.warn('context', 'No personality files found, using minimal prompt')
    return `You are Kira, a helpful AI assistant. Be concise, direct, and use tools when needed.

${sections[0]}`
  }

  return sections.join('\n\n---\n\n')
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
  options: SystemPromptOptions = {}
): AgentContext {
  const systemPrompt = buildSystemPrompt(config, options)

  log.debug('context', `Built system prompt (${systemPrompt.length} chars)`)

  return {
    systemPrompt,
    messages: [],
    workspaceDir: config.workspace.path,
    sessionId,
  }
}

export function addMessage(context: AgentContext, message: ChatMessage): void {
  context.messages.push(message)
}

export function getMessagesWithSystem(context: AgentContext): ChatMessage[] {
  return [
    { role: 'system', content: context.systemPrompt },
    ...context.messages,
  ]
}
