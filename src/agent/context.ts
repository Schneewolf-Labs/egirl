import type { ChatMessage } from '../providers/types'
import type { RuntimeConfig } from '../config'

export interface AgentContext {
  systemPrompt: string
  messages: ChatMessage[]
  workspaceDir: string
  sessionId: string
}

const DEFAULT_SYSTEM_PROMPT = `You are egirl, a helpful AI assistant with access to tools.

You have the following capabilities:
- Read, write, and edit files
- Execute shell commands
- Search for files using glob patterns
- Store and retrieve memories

Guidelines:
- Be concise and helpful
- Use tools when needed to accomplish tasks
- Ask for clarification if instructions are unclear
- Be careful with file operations and command execution`

export function buildSystemPrompt(config: RuntimeConfig, additionalContext?: string): string {
  let prompt = DEFAULT_SYSTEM_PROMPT

  if (additionalContext) {
    prompt += `\n\n${additionalContext}`
  }

  return prompt
}

export function createAgentContext(
  config: RuntimeConfig,
  sessionId: string,
  additionalContext?: string
): AgentContext {
  return {
    systemPrompt: buildSystemPrompt(config, additionalContext),
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
