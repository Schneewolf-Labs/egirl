import { join } from 'path'
import { createAgentLoop } from '../agent/loop'
import type { SessionMutex } from '../agent/session-mutex'
import type { AgentLoopDeps } from '../agent/types'
import type { RuntimeConfig } from '../config'
import type { ConversationStore } from '../conversation'
import type { MemoryManager } from '../memory'
import type { LLMProvider } from '../providers/types'
import type { Skill } from '../skills/types'
import type { ToolExecutor } from '../tools'
import { ClaudeOperator } from './claude'
import { CodexOperator } from './codex'
import { openSessionMap } from './session-map'
import type { Operator, OperatorFactory } from './types'

export type { Operator, OperatorFactory } from './types'

/** What it takes to build one operator for one session. */
export interface OperatorDeps extends AgentLoopDeps {
  /**
   * Begin a new conversation rather than continue the stored one. The local loop starts from
   * whatever transcript it is handed, so this only matters to an operator that keeps its own.
   */
  isFresh?: boolean
}

export type OperatorBuilder = (deps: OperatorDeps) => Operator

/**
 * Operators of the one kind `[operator]` names. The choice is made once per instance, here, at
 * startup: chat sessions, background tasks and discovery all build through the same builder,
 * and nothing downstream knows or picks which kind it got. Build it once per process and pass
 * it down, so every hosted session in the process goes through one session map.
 */
export function createOperatorBuilder(config: RuntimeConfig): OperatorBuilder {
  const provider = config.operator?.provider ?? 'local'
  if (provider === 'local') {
    return ({ isFresh: _, ...deps }) => createAgentLoop(deps)
  }
  const sessions = openSessionMap(join(config.workspace.path, `${provider}-sessions.json`))
  if (provider === 'codex') return (deps) => new CodexOperator({ ...deps, sessions })
  return (deps) => new ClaudeOperator({ ...deps, sessions })
}

export interface OperatorFactoryDeps {
  config: RuntimeConfig
  toolExecutor: ToolExecutor
  localProvider: LLMProvider
  auxProvider?: LLMProvider
  memory?: MemoryManager
  conversationStore?: ConversationStore
  skills?: Skill[]
  additionalContext?: string
  sessionMutex: SessionMutex
}

/** Per-session operators for the chat surfaces. */
export function createOperatorFactory(
  deps: OperatorFactoryDeps,
  build: OperatorBuilder = createOperatorBuilder(deps.config),
): OperatorFactory {
  return (sessionId: string): Operator => build({ ...deps, sessionId })
}
