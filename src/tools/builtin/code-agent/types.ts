import type { CodeAgentProvider } from '../../../config/schema'
import type { MemoryManager } from '../../../memory'
import type { PermissionSupervisor } from '../../../permissions/supervisor'
import type { LLMProvider } from '../../../providers/types'
import type { ToolResult } from '../../types'

export type { CodeAgentProvider }

export interface CodeAgentConfig {
  provider?: CodeAgentProvider
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  model?: string
  workingDir: string
  maxTurns?: number
  timeoutMs?: number
  localProvider?: LLMProvider
  memory?: MemoryManager
  permissionSupervisor?: PermissionSupervisor
}

/**
 * The contract every code-agent backend implements. A new backend (claude,
 * codex, opencode, …) is a function with this signature plus a literal in
 * CODE_AGENT_PROVIDERS and an entry in the dispatch map in ./index.ts.
 */
export type CodeAgentBackend = (
  config: CodeAgentConfig,
  task: string,
  workingDir: string,
) => Promise<ToolResult>
