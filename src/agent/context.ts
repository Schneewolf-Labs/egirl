import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { ChatMessage } from '../providers/types'
import type { RuntimeConfig } from '../config'
import { log } from '../util/logger'

export interface AgentContext {
  systemPrompt: string
  messages: ChatMessage[]
  workspaceDir: string
  sessionId: string
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

/**
 * Build system prompt from workspace personality files
 */
export function buildSystemPrompt(config: RuntimeConfig, additionalContext?: string): string {
  const { path: workspaceDir } = config.workspace

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
- \`read_file\` - Read file contents
- \`write_file\` - Write content to a file
- \`edit_file\` - Edit with string replacement
- \`execute_command\` - Run shell commands
- \`glob_files\` - Find files by pattern
- \`memory_search\` - Search memories (hybrid keyword + semantic)
- \`memory_get\` - Retrieve a specific memory by key
- \`memory_set\` - Store a memory for later recall
- \`web_research\` - Fetch a URL and return its text content

Use tools proactively to gather information rather than asking.`)

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

export function createAgentContext(
  config: RuntimeConfig,
  sessionId: string,
  additionalContext?: string
): AgentContext {
  const systemPrompt = buildSystemPrompt(config, additionalContext)

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
