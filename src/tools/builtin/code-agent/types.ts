import type { CodeAgentProvider } from '../../../config/schema'
import type { MemoryManager } from '../../../memory'
import type { PermissionSupervisor } from '../../../permissions/supervisor'
import type { LLMProvider } from '../../../providers/types'
import type { DelegationControl } from '../../delegation-registry'
import type { ToolResult } from '../../types'

export type { CodeAgentProvider }

export interface CodeAgentConfig {
  provider?: CodeAgentProvider
  /** Ordered fallback chain. Takes precedence over `provider` when non-empty. */
  providers?: CodeAgentProvider[]
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
 *
 * `control` is present only for a backgrounded delegation. Absent, the backend runs exactly
 * as it always has — one blocking call, no channel to watch — which is what keeps the
 * foreground path unchanged.
 */
export type CodeAgentBackend = (
  config: CodeAgentConfig,
  task: string,
  workingDir: string,
  control?: DelegationControl,
) => Promise<ToolResult>

/**
 * Whether a backend can take a steering message mid-run. Declared rather than assumed: a
 * backend that cannot must say so, so `code_agent_steer` can tell the operator to stop and
 * re-delegate instead of accepting a message that goes nowhere.
 */
export const STEERABLE_BACKENDS: Record<CodeAgentProvider, boolean> = {
  claude: true,
  codex: false,
  opencode: false,
}
