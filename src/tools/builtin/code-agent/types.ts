import type { CodeAgentProvider } from '../../../config/schema'
import type { MemoryManager } from '../../../memory'
import type { PermissionSupervisor } from '../../../permissions/supervisor'
import type { LLMProvider } from '../../../providers/types'
import type { ToolResult } from '../../types'

export type { CodeAgentProvider }

export interface CodeAgentConfig {
  provider?: CodeAgentProvider
  /** Ordered fallback chain. Takes precedence over `provider` when non-empty. */
  providers?: CodeAgentProvider[]
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto'
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
  /** Absolute paths of image files to show the agent along with the task. */
  images?: string[],
  options?: CodeAgentRunOptions,
) => Promise<ToolResult>

export interface CodeAgentRunOptions {
  /**
   * Continue this backend session/thread (from a timeout report) instead of starting fresh; the
   * task becomes the next instruction. A backend that cannot resume returns a failure saying so.
   */
  resumeSession?: string
}
