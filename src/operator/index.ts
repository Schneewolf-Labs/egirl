import { join } from 'path'
import { createAgentLoop } from '../agent/loop'
import type { SessionMutex } from '../agent/session-mutex'
import type { RuntimeConfig } from '../config'
import type { ConversationStore } from '../conversation'
import type { MemoryManager } from '../memory'
import type { LLMProvider } from '../providers/types'
import type { Skill } from '../skills/types'
import type { ToolExecutor } from '../tools'
import { ClaudeOperator } from './claude'
import { openClaudeSessionMap } from './claude-sessions'
import type { Operator, OperatorFactory } from './types'

export type { Operator, OperatorFactory } from './types'

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

/**
 * Per-session operators for this instance, of the one kind `[operator]` names. The choice is
 * made once per instance here, at startup: nothing downstream knows or picks which it got.
 */
export function createOperatorFactory(deps: OperatorFactoryDeps): OperatorFactory {
  const provider = deps.config.operator?.provider ?? 'local'
  if (provider === 'local') {
    return (sessionId: string): Operator => createAgentLoop({ ...deps, sessionId })
  }
  const sessions = openClaudeSessionMap(join(deps.config.workspace.path, 'claude-sessions.json'))
  return (sessionId: string): Operator => new ClaudeOperator({ ...deps, sessionId, sessions })
}
